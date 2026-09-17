import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401, getOwnerForAsset } from '@/lib/auth';
import {
  deleteFileById,
  fileById,
  readFileById,
  renameFileById,
  setIndexingMode,
  upsertFile,
} from '@/lib/files';
import { copyFileById, moveFileById } from '@mantle/files';
import { thumbnailFor } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';

const IdParams = z.object({ id: z.string().uuid() });
const PatchBody = z.union([
  z.object({ content: z.string().max(2_000_000) }),
  z.object({ rename: z.string().min(1).max(200) }),
  // 'inherit' clears the file's own flag (the folder chain decides again).
  z.object({ indexing: z.enum(['full', 'metadata', 'inherit']) }),
  // Move to another folder (filename unchanged; rename is its own action).
  z.object({ move: z.string().min(1).max(500) }),
]);

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  // getOwnerForAsset (not getOwnerOr401): the `?raw=1` bytes are loaded as an
  // <img>/<iframe>/download src that can't carry a bearer, so a detached client
  // authenticates via the `?at=` asset token. Session (cookie/bearer) still wins.
  const user = await getOwnerForAsset(_req);
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
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
      return new Response(null, { status: 304, headers: { etag } });
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
        // cache privately and revalidate via etag when the content changes.
        etag,
        'cache-control': 'private, max-age=3600',
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
      file,
      content: res ? res.bytes.toString('utf8') : '',
    });
  }
  return NextResponse.json({ file });
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
    .object({ copy_to: z.string().min(1).max(500), new_filename: z.string().max(200).optional() })
    .safeParse(raw);
  if (!body.success) {
    return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  }
  try {
    const file = await copyFileById({
      ownerId: user.id,
      fileId: idParsed.data.id,
      destPath: body.data.copy_to,
      newFilename: body.data.new_filename,
    });
    return NextResponse.json({ file }, { status: 201 });
  } catch (err) {
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
