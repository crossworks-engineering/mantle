import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { ensureFilesRootBranch, listFiles, listRecentFiles, upsertFile } from '@/lib/files';
import { MAX_UPLOAD_BYTES, MEDIA_EXTS, extOf } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';

const ListQuery = z.union([
  z.object({ parent: z.string().min(1).max(500) }),
  // Cross-tree recency view — the left pane's "Recent" entry. Rows carry
  // parentPath, so the client can show where each file lives.
  z.object({ recent: z.literal('1'), limit: z.coerce.number().int().min(1).max(200).optional() }),
]);

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  await ensureFilesRootBranch(user.id);
  const url = new URL(req.url);
  const parsed = ListQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid query' }, { status: 400 });
  }
  if ('recent' in parsed.data) {
    const files = await listRecentFiles({ ownerId: user.id, limit: parsed.data.limit });
    return NextResponse.json({ files });
  }
  const files = await listFiles({ ownerId: user.id, parentPath: parsed.data.parent });
  return NextResponse.json({ files });
}

/**
 * Accepts either:
 *   1. multipart/form-data with fields `parentPath`, `file` (binary)
 *   2. application/json with `{ parentPath, filename, content }` for
 *      text-file creation (markdown / txt / json from the editor)
 */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  await ensureFilesRootBranch(user.id);
  const contentType = req.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const parentPath = String(form.get('parentPath') ?? '');
      const file = form.get('file');
      if (!parentPath || !(file instanceof File)) {
        return NextResponse.json({ error: 'parentPath and file required' }, { status: 400 });
      }
      if (file.size === 0) {
        return NextResponse.json({ error: 'empty file' }, { status: 400 });
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        // A rejected video deserves a pointer to the path that DOES work —
        // media is meant to enter by link (video_ingest), not by upload.
        const mediaHint = MEDIA_EXTS.has(extOf(file.name))
          ? ' For video, ask the assistant to ingest the link instead.'
          : '';
        return NextResponse.json(
          { error: `file too large (>${MAX_UPLOAD_BYTES / 1024 / 1024} MB).${mediaHint}` },
          { status: 413 },
        );
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const row = await upsertFile({
        ownerId: user.id,
        parentPath,
        filename: file.name,
        bytes: buf,
      });
      // Record the ingest event so the node-biography view has a
      // "what came in" anchor. Truncated content snippet (first ~2KB)
      // gets attached as a step so the biography page can show what
      // was actually uploaded without re-reading from disk.
      void recordIngest({
        source: 'file_upload',
        ownerId: user.id,
        nodeId: row.id,
        summary: `File uploaded: ${row.filename}`,
        payload: {
          parentPath,
          filename: row.filename,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          via: 'web_multipart',
        },
        snippet: tryUtf8Snippet(buf),
      });
      return NextResponse.json({ file: row });
    }

    const raw = await req.json().catch(() => ({}));
    const TextBody = z.object({
      parentPath: z.string().min(1).max(500),
      filename: z.string().min(1).max(200),
      content: z.string().max(2_000_000), // 2 MB cap for inline text creation
    });
    const parsed = TextBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'invalid input' },
        { status: 400 },
      );
    }
    const buf = Buffer.from(parsed.data.content, 'utf8');
    const row = await upsertFile({
      ownerId: user.id,
      parentPath: parsed.data.parentPath,
      filename: parsed.data.filename,
      bytes: buf,
    });
    void recordIngest({
      source: 'file_create',
      ownerId: user.id,
      nodeId: row.id,
      summary: `Text file created: ${row.filename}`,
      payload: {
        parentPath: parsed.data.parentPath,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        via: 'web_json',
      },
      // Text-file creation is always utf-8; no encoding check needed.
      snippet: parsed.data.content,
    });
    return NextResponse.json({ file: row });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('file_filename_in_parent_uq') || msg.includes('duplicate key')) {
      return NextResponse.json(
        { error: 'a file with that name already exists in this folder' },
        { status: 409 },
      );
    }
    if (msg.includes('already exists')) {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

/**
 * Best-effort UTF-8 snippet of a binary buffer for the ingest trace.
 * If the buffer decodes to mostly-printable text, return the first
 * ~2KB so the biography page can show "what came in." If it looks
 * like binary garbage (>10% non-printable in the sample), return
 * undefined — a base64 dump would be useless and noisy.
 *
 * Capped at 2KB before printability check so we don't decode a 25MB
 * PDF just to throw it away.
 */
function tryUtf8Snippet(buf: Buffer): string | undefined {
  const sample = buf.subarray(0, 2048);
  const text = sample.toString('utf8');
  // Quick printability heuristic: count chars that are control codes
  // outside the usual whitespace set (\t \n \r). If >10% are
  // controls, it's binary.
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) bad++;
    if (c === 0xfffd) bad++; // replacement char from invalid utf-8
  }
  if (text.length === 0 || bad / text.length > 0.1) return undefined;
  return text;
}

const BulkDeleteBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  /** Confirmed cascade: also delete the nodes ingest derived from each file
   *  (extracted images, imported tables, pages, notes). Without it, files
   *  with derived nodes are refused and reported back for a confirm dialog. */
  cascade: z.boolean().optional(),
});

export async function DELETE(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = BulkDeleteBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  if (parsed.data.cascade) {
    const { deleteFileWithDerived } = await import('@mantle/content');
    let deleted = 0;
    let reapedTotal = 0;
    for (const id of parsed.data.ids) {
      const res = await deleteFileWithDerived(user.id, id);
      if (res.ok) deleted++;
      reapedTotal += res.reaped.total;
    }
    return NextResponse.json({ deleted, hasDerived: [], reapedTotal });
  }
  const { bulkDeleteFiles } = await import('@/lib/files');
  const res = await bulkDeleteFiles({ ownerId: user.id, fileIds: parsed.data.ids });
  return NextResponse.json(res);
}
