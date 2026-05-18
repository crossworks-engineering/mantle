import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { ensureFilesRootBranch, listFiles, upsertFile } from '@/lib/files';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB — generous for personal use.

const ListQuery = z.object({ parent: z.string().min(1).max(500) });

export async function GET(req: Request) {
  const user = await requireOwner();
  await ensureFilesRootBranch(user.id);
  const url = new URL(req.url);
  const parsed = ListQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid query' }, { status: 400 });
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
  const user = await requireOwner();
  await ensureFilesRootBranch(user.id);
  const contentType = req.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const parentPath = String(form.get('parentPath') ?? '');
      const file = form.get('file');
      if (!parentPath || !(file instanceof File)) {
        return NextResponse.json(
          { error: 'parentPath and file required' },
          { status: 400 },
        );
      }
      if (file.size === 0) {
        return NextResponse.json({ error: 'empty file' }, { status: 400 });
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { error: `file exceeds ${MAX_UPLOAD_BYTES} bytes` },
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

const BulkDeleteBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

export async function DELETE(req: Request) {
  const user = await requireOwner();
  const raw = await req.json().catch(() => ({}));
  const parsed = BulkDeleteBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const { bulkDeleteFiles } = await import('@/lib/files');
  const res = await bulkDeleteFiles({ ownerId: user.id, fileIds: parsed.data.ids });
  return NextResponse.json(res);
}
