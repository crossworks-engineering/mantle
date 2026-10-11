import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { cappedOne } from '@/lib/list-workspaces';
import { getOwnerOr401, getReaderForAsset } from '@/lib/auth';
import { memberBytesGate } from '@/lib/member-space';
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
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';
import { TreeVisibilityError, guardFileCopyTo, guardFileTo } from '@mantle/content/tree';
import { treeErrorResponse } from '@/lib/tree-route';
import { isBusy, isScopeWriteRefusal } from '@mantle/db';
import { callerMayReadEmail } from '@/lib/api-v1';

const IdParams = z.object({ id: z.string().uuid() });
/** A file's raw bytes are read in the login's scope (W7e): never stored. */
const RAW_CACHE = 'private, no-store';
/** A thumbnail is kept privately but revalidated on every use (its etag). */
const THUMB_CACHE = 'private, no-cache';
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
  // getReaderForAsset (not getOwnerOr401): the `?raw=1` bytes are loaded as an
  // <img>/<iframe>/download src that can't carry a bearer, so a detached client
  // authenticates via the `?at=` asset token. Session (cookie/bearer) still wins.
  // Every login since W7e: a member reads the detail AND the bytes of a file
  // in its own scope (MEMBER_OPEN_READS); a file it does not read is a 404.
  const reader = await getReaderForAsset(_req);
  if (reader instanceof Response) return reader;
  const user = reader.user;
  // A member's bytes are rate limited per login, as on the member routes.
  const bytesAsked = new URL(_req.url).searchParams;
  if (reader.member && (bytesAsked.has('raw') || bytesAsked.has('thumb'))) {
    const limited = memberBytesGate(_req, reader.member);
    if (limited) return limited;
  }
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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  try {
    if ('move' in parsed.data) {
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
    const existing = await fileById({ ownerId: user.id, fileId: idParsed.data.id });
    if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if (!existing.isText) {
      return NextResponse.json(
        { error: 'only text files (.md / .txt / .json / .yaml / .yml) can be edited in place' },
        { status: 400 },
      );
    }
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
  } catch (err) {
    // A scope refusal is the app's 403 (W6a fix round 2), never a 400 (W7e).
    if (isScopeWriteRefusal(err)) throw err;
    if (err instanceof TreeVisibilityError || isBusy(err)) return treeErrorResponse(err);
    const msg = errorMessage(err);
    if (msg.includes('already exists')) {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

/** Copy this file into another folder — a new node with its own bytes and
 *  its own extraction under the destination's indexing mode. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const raw = await req.json().catch(() => ({}));
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
  try {
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
  } catch (err) {
    // A scope refusal is the app's 403 (W6a fix round 2), never a 400.
    if (isScopeWriteRefusal(err)) throw err;
    if (err instanceof TreeVisibilityError || isBusy(err)) return treeErrorResponse(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'copy failed' },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
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
    return NextResponse.json({ ok: true, reaped: res.reaped, skipped: res.skipped });
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
