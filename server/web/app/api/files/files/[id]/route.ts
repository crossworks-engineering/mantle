import { NextResponse } from '@/server/http-compat';
import { assertItemRight } from '@mantle/db';
import { z } from 'zod';
import { cappedOne } from '@/lib/list-workspaces';
import { ownerCaller, readerAssetCaller } from '@/lib/auth';
import {
  deleteFileById,
  fileById,
  readFileById,
  renameFileById,
  setIndexingMode,
  upsertFile,
} from '@/lib/files';
import { copyFileById, emailAttachmentIds, moveFileById } from '@mantle/files';
import { thumbnailFor } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import { firstIssue } from '@/lib/zod-issue';
import { guardFileCopyTo, guardFileTo } from '@mantle/content/tree';
import { callerMayReadEmail } from '@/lib/api-v1';
import { readJson } from '@/lib/read-body';
import { CACHE_CONTROL } from '@/lib/cache-control';
import type { FileCascadeDeleteResponse } from '@mantle/client-types';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). Since the pre-check removal part 2 the
 *  item gate no longer answers a bad id here (docs/actors.md). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner', limits: { rateLimit: ['memberBytes', 'memberThumbs'] } },
  POST: {
    class: 'content',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
  PATCH: {
    class: 'content',
    open: 'owner',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
  DELETE: {
    class: 'content',
    open: 'owner',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

/** A write's first read (pre-check removal part 2): the file in the
 *  caller's scope, the 404 of none for one it does not read (as for an id
 *  no row has), before the body is read or anything is written. */
async function fileOr404(ownerId: string, fileId: string) {
  return (await fileById({ ownerId, fileId })) ?? null;
}
const NOT_FOUND = () => NextResponse.json({ error: 'not found' }, { status: 404 });

const IdParams = z.object({ id: z.string().uuid() });
/** A file's raw bytes are read in the login's scope (W7e): never stored. */
const RAW_CACHE = CACHE_CONTROL.privateNone;
/** A thumbnail is kept privately but revalidated on every use (its etag). */
const THUMB_CACHE = CACHE_CONTROL.privateRevalidate;
const PatchBody = z.union([
  z.object({ content: z.string().max(2_000_000) }),
  z.object({ rename: z.string().min(1).max(200) }),
  // 'inherit' clears the file's own flag (the folder chain decides again).
  z.object({ indexing: z.enum(['full', 'metadata', 'inherit']) }),
  // Move to another folder (filename unchanged; rename is its own action).
  // Into or out of a shared folder: 409 `visibility` unless `confirm`.
  z.object({
    move: z.string().min(1).max(500),
    confirm: z.boolean().optional(),
    seen: z.number().int().min(0).optional(),
  }),
]);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  // The asset reader (readerAssetCaller: the gate's answer of
  // getReaderForAsset, A4 hand batch B), not the owner: the `?raw=1` bytes are
  // loaded as an <img>/<iframe>/download src that can't carry a bearer, so a
  // detached client authenticates via the `?at=` asset token. Session
  // (cookie/bearer) still wins. Every login since W7e: a member reads the
  // detail AND the bytes of a file in its own scope (MEMBER_OPEN_READS); a
  // file it does not read is a 404.
  // A member's bytes are rate limited per login (the file and its
  // thumbnail each a budget of their own): the gate took the row's limits
  // (lib/route-limits.ts memberBytes, memberThumbs).
  const reader = readerAssetCaller();
  const user = reader.user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  // An API key without the Search area does not reach an email attachment
  // (access matrix M4): not found, its metadata and its bytes alike.
  if (
    !callerMayReadEmail() &&
    (await emailAttachmentIds(user.id, [idParsed.data.id])).has(idParsed.data.id)
  ) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const url = new URL(_req.url);
  if (url.searchParams.get('thumb') === '1') {
    // Cached image derivative for grid tiles. 404 = "no thumbnail possible"
    // (not an image, decode failed, oversized) — the client falls back to the
    // type icon; it must never treat this as an error state. Metadata first:
    // a cache hit (disk or browser) must never read the original bytes.
    const meta = await fileById({ ownerId: user.id, fileId: idParsed.data.id });
    if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const sha = meta.sha256;
    if (!sha) return NextResponse.json({ error: 'no thumbnail' }, { status: 404 });
    const etag = `"${sha}.thumb"`;
    if (_req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag, 'cache-control': THUMB_CACHE } });
    }
    const thumb = await thumbnailFor({
      sha256: sha,
      mimeType: meta.mimeType,
      loadBytes: async () => {
        const res = await readFileById({ ownerId: user.id, fileId: meta.id });
        return res ? res.bytes : null;
      },
    });
    if (!thumb) return NextResponse.json({ error: 'no thumbnail' }, { status: 404 });
    return new Response(new Uint8Array(thumb), {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(thumb.byteLength),
        // Keyed by content hash server-side; the URL is stable per file id, so
        // cache privately and revalidate via etag on every use: the etag
        // check above runs after the scoped lookup, so a login that lost the
        // file stops getting it at once (W7e fix round 1, L2).
        etag,
        'cache-control': THUMB_CACHE,
      },
    });
  }
  if (url.searchParams.get('raw') === '1') {
    const res = await readFileById({ ownerId: user.id, fileId: idParsed.data.id });
    if (!res) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return new Response(new Uint8Array(res.bytes), {
      status: 200,
      headers: {
        ...safeDownloadHeaders(res.row.mimeType, res.row.filename),
        'content-length': String(res.bytes.byteLength),
        // Never kept by a shared cache or the browser (W7e fix round 1, L2).
        'cache-control': RAW_CACHE,
      },
    });
  }
  const file = await fileById({ ownerId: user.id, fileId: idParsed.data.id });
  if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // Include content for text files so the editor can open it without
  // a second round-trip.
  if (file.isText) {
    const res = await readFileById({ ownerId: user.id, fileId: file.id });
    return NextResponse.json({
      file: await cappedOne(file),
      content: res ? res.bytes.toString('utf8') : '',
    });
  }
  return NextResponse.json({ file: await cappedOne(file) });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const existing = await fileOr404(user.id, idParsed.data.id);
  if (!existing) return NOT_FOUND();
  const raw = await readJson(req);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  if ('move' in parsed.data) {
    // A move manages the file: asked before the guard reads the
    // destination (moveFileById asks it again).
    await assertItemRight(existing.id, 'manage');
    await guardFileTo(user.id, idParsed.data.id, parsed.data.move, {
      confirm: parsed.data.confirm === true,
      seen: parsed.data.seen,
    });
    const file = await moveFileById({
      ownerId: user.id,
      fileId: idParsed.data.id,
      destPath: parsed.data.move,
    });
    return NextResponse.json({ file });
  }
  if ('indexing' in parsed.data) {
    await setIndexingMode({
      ownerId: user.id,
      nodeId: idParsed.data.id,
      mode: parsed.data.indexing,
    });
    const file = await fileById({ ownerId: user.id, fileId: idParsed.data.id });
    if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ file });
  }
  if ('rename' in parsed.data) {
    const file = await renameFileById({
      ownerId: user.id,
      fileId: idParsed.data.id,
      newStem: parsed.data.rename,
    });
    if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ file });
  }
  // Content edit: load the existing row to get the filename + parent, then
  // overwrite via upsertFile (which clears the extracted summary so the
  // next extractor run re-processes the changed body).
  if (!existing.isText) {
    return NextResponse.json(
      { error: 'only text files (.md / .txt / .json / .yaml / .yml) can be edited in place' },
      { status: 400 },
    );
  }
  // The edit first: before the new bytes are written.
  await assertItemRight(existing.id, 'edit');
  const buf = Buffer.from(parsed.data.content, 'utf8');
  const file = await upsertFile({
    ownerId: user.id,
    parentPath: existing.parentPath,
    filename: existing.filename,
    bytes: buf,
    overwrite: true,
  });
  // Record the edit as a fresh ingest event — the file's content
  // changed, the extractor will re-run, and the biography view
  // should reflect "this thing was edited at HH:MM" alongside the
  // original upload.
  void recordIngest({
    source: 'file_edit',
    ownerId: user.id,
    nodeId: file.id,
    summary: `File edited: ${file.filename}`,
    payload: {
      parentPath: existing.parentPath,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      previousSizeBytes: existing.sizeBytes,
      via: 'web_inline_edit',
    },
    snippet: parsed.data.content,
  });
  return NextResponse.json({ file });
}

/** Copy this file into another folder — a new node with its own bytes and
 *  its own extraction under the destination's indexing mode. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  if (!(await fileOr404(user.id, idParsed.data.id))) return NOT_FOUND();
  const raw = await readJson(req);
  const body = z
    .object({
      copy_to: z.string().min(1).max(500),
      new_filename: z.string().max(200).optional(),
      // Into a shared folder: 409 `visibility` unless confirmed.
      confirm: z.boolean().optional(),
      seen: z.number().int().min(0).optional(),
    })
    .safeParse(raw);
  if (!body.success) {
    return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  }
  // A copy asks the file's edit, as the item gate did, before the guard
  // reads the destination and before any byte is copied.
  await assertItemRight(idParsed.data.id, 'edit');
  await guardFileCopyTo(user.id, idParsed.data.id, body.data.copy_to, {
    confirm: body.data.confirm === true,
    seen: body.data.seen,
  });
  const file = await copyFileById({
    ownerId: user.id,
    fileId: idParsed.data.id,
    destPath: body.data.copy_to,
    newFilename: body.data.new_filename,
  });
  return NextResponse.json({ file }, { status: 201 });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  // A delete manages the file: the 404 of none for one the scope does not
  // read, the edit check's refusal (403) for one it reads and may not
  // delete, before the derived items are counted or reaped.
  if (!(await fileOr404(user.id, idParsed.data.id))) return NOT_FOUND();
  await assertItemRight(idParsed.data.id, 'manage');
  const cascade = new URL(_req.url).searchParams.get('cascade') === '1';
  if (cascade) {
    // Confirmed cascade: reap the derived nodes first, then the source file.
    const { deleteFileWithDerived } = await import('@mantle/content');
    const res = await deleteFileWithDerived(user.id, idParsed.data.id);
    if (!res.ok) {
      if (res.reason === 'attachment') {
        return NextResponse.json(
          {
            error:
              "Can't delete — this file is an email attachment. Delete it from the email instead.",
          },
          { status: 409 },
        );
      }
      if (res.reason === 'in_drawing') {
        const names = (res.drawings ?? []).map((d) => d.title).join(', ');
        return NextResponse.json(
          {
            error: `Can't delete — this image is used in ${names || 'a drawing'}. Remove it from the drawing first.`,
            reason: 'in_drawing',
            drawings: res.drawings ?? [],
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    // `kept`: derived items the caller may not delete, left in place (F4
    // fix round 3, H1): a count, never a name.
    const body: FileCascadeDeleteResponse = {
      ok: true,
      reaped: res.reaped,
      skipped: res.skipped,
      kept: res.kept,
    };
    return NextResponse.json(body);
  }
  const res = await deleteFileById({ ownerId: user.id, fileId: idParsed.data.id });
  if (!res.ok) {
    if (res.reason === 'has_derived' && res.derived) {
      // Count-and-confirm: nothing was deleted. The client shows the counts
      // and retries with ?cascade=1 once the user confirms.
      return NextResponse.json(
        { error: 'file has derived nodes', reason: 'has_derived', derived: res.derived },
        { status: 409 },
      );
    }
    if (res.reason === 'attachment') {
      return NextResponse.json(
        {
          error:
            "Can't delete — this file is an email attachment. Delete it from the email instead.",
        },
        { status: 409 },
      );
    }
    if (res.reason === 'in_drawing') {
      const names = (res.drawings ?? []).map((d) => d.title).join(', ');
      return NextResponse.json(
        {
          error: `Can't delete — this image is used in ${names || 'a drawing'}. Remove it from the drawing first.`,
          reason: 'in_drawing',
          drawings: res.drawings ?? [],
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
