import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401, getOwnerForAsset } from '@/lib/auth';
import { deleteFileById, fileById, readFileById, renameFileById, upsertFile } from '@/lib/files';
import { recordIngest } from '@mantle/tracing';
import { safeDownloadHeaders } from '@mantle/web-ui/lib/safe-download';

const IdParams = z.object({ id: z.string().uuid() });
const PatchBody = z.union([
  z.object({ content: z.string().max(2_000_000) }),
  z.object({ rename: z.string().min(1).max(200) }),
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
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }

  try {
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
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists')) {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const res = await deleteFileById({ ownerId: user.id, fileId: idParsed.data.id });
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
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
