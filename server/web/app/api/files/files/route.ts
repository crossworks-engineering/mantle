import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { callerMayConfirm, callerMayReadEmail } from '@/lib/api-v1';
import { getOwnerOr401 } from '@/lib/auth';
import { allPrivateRows, listStateOf } from '@/lib/admin-private-rows';
import { ensureFilesRootBranch, listFiles, listRecentFiles, upsertFile } from '@/lib/files';
import {
  emailAttachmentIds,
  MEDIA_EXTS,
  UploadTooLargeError,
  diskPathForFile,
  discardSpooled,
  extOf,
  maxStreamedUploadBytes,
  sweepSpool,
  FILES_ROOT_LABEL,
} from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import { promises as fs } from 'node:fs';
import { readMultipartUpload, type ParsedUpload } from '@/lib/upload-stream';
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';
import { isBusy, isUniqueViolation } from '@mantle/db';
import { TreeVisibilityError, guardNewFileIn } from '@mantle/content/tree';
import { treeErrorResponse } from '@/lib/tree-route';

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
  // `?state=brain|private|all` (item-list alignment, lib/admin-private-rows):
  // the caller's own private files join the ROOT folder (by name) and Recent
  // (by time); no other folder holds any. Default brain, as before.
  const state = listStateOf(url.searchParams);
  // An API key without the Search area does not see email attachments
  // (access matrix M4): they are file nodes, so Files would list them.
  const withoutMail = async <T extends { id: string }>(rows: T[]): Promise<T[]> => {
    if (callerMayReadEmail() || rows.length === 0) return rows;
    const mail = await emailAttachmentIds(
      user.id,
      rows.map((r) => r.id),
    );
    return rows.filter((r) => !mail.has(r.id));
  };
  if ('recent' in parsed.data) {
    const limit = parsed.data.limit;
    const [brain, own] = await Promise.all([
      state === 'private' ? [] : listRecentFiles({ ownerId: user.id, limit }).then(withoutMail),
      state === 'brain' ? [] : allPrivateRows(user, 'file', { cap: limit ?? 50 }),
    ]);
    const files = [...brain, ...own]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .slice(0, Math.min(200, Math.max(1, limit ?? 50)));
    return NextResponse.json({ files });
  }
  const atRoot = parsed.data.parent === FILES_ROOT_LABEL;
  const [brain, own] = await Promise.all([
    state === 'private'
      ? []
      : listFiles({ ownerId: user.id, parentPath: parsed.data.parent }).then(withoutMail),
    state === 'brain' || !atRoot ? [] : allPrivateRows(user, 'file', { sort: 'title' }),
  ]);
  const files = [...brain, ...own].sort((a, b) =>
    ('filename' in a ? a.filename : a.title).localeCompare('filename' in b ? b.filename : b.title),
  );
  return NextResponse.json({ files });
}

/**
 * Accepts either:
 *   1. multipart/form-data with fields `parentPath`, `file` (binary):
 *      STREAMED to disk, capped by MANTLE_MAX_UPLOAD_MB (default 512)
 *   2. application/json with `{ parentPath, filename, content }` for
 *      text-file creation (markdown / txt / json from the editor)
 * Into a shared folder the file is read by the team or clients at once:
 * 409 `visibility` (TreeVisibilityRefusal) unless `confirm` is `true` (a
 * form field, sent before the file part, or the JSON body's `confirm`).
 * A name already taken in the folder is 409 unless the multipart form says
 * `replace=true`: then the new bytes replace the file in place (same node,
 * so links and history hold; its old index is dropped and rebuilt).
 */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  await ensureFilesRootBranch(user.id);
  const contentType = req.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('multipart/form-data')) {
      // Streamed: the body spools to disk as it arrives (see lib/upload-stream),
      // so the cap here is a disk/UX number, not a memory one: the old
      // `req.formData()` path buffered the whole file (and a copy) before it
      // could even say "too large".
      void sweepSpool();
      const maxBytes = maxStreamedUploadBytes();
      let parsed: ParsedUpload;
      try {
        parsed = await readMultipartUpload(req, { maxBytes });
      } catch (err) {
        if (err instanceof UploadTooLargeError) {
          // A rejected video deserves a pointer to the path that DOES work:
          // media is meant to enter by link (video_ingest), not by upload.
          const mediaHint =
            err.filename && MEDIA_EXTS.has(extOf(err.filename))
              ? ' For video, ask the assistant to ingest the link instead.'
              : '';
          return NextResponse.json(
            { error: `${err.message}.${mediaHint}`, maxUploadBytes: maxBytes },
            { status: 413 },
          );
        }
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'malformed upload' },
          { status: 400 },
        );
      }
      const parentPath = parsed.fields.parentPath ?? '';
      const upload = parsed.file;
      if (!parentPath || !upload) {
        if (upload) await discardSpooled(upload.spooled);
        return NextResponse.json({ error: 'parentPath and file required' }, { status: 400 });
      }
      if (upload.spooled.size === 0) {
        await discardSpooled(upload.spooled);
        return NextResponse.json({ error: 'empty file' }, { status: 400 });
      }
      let row;
      try {
        await guardNewFileIn(user.id, parentPath, upload.filename, {
          // An API key never confirms a visibility change (lib/api-v1.ts).
          confirm: parsed.fields.confirm === 'true' && callerMayConfirm(),
        });
        row = await upsertFile({
          ownerId: user.id,
          parentPath,
          filename: upload.filename,
          spooled: upload.spooled,
          overwrite: parsed.fields.replace === 'true',
        });
      } finally {
        // No-op once adopted (the rename moved it); the safety net for every
        // failure between spool and adoption (parent missing, bad name, …).
        await discardSpooled(upload.spooled);
      }
      // Record the ingest event so the node-biography view has a
      // "what came in" anchor. Truncated content snippet (first ~2KB)
      // gets attached as a step so the biography page can show what
      // was actually uploaded without re-reading the whole file.
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
        snippet: await tryUtf8SnippetFromDisk(parentPath, row.filename),
      });
      return NextResponse.json({ file: row });
    }

    const raw = await req.json().catch(() => ({}));
    const TextBody = z.object({
      parentPath: z.string().min(1).max(500),
      filename: z.string().min(1).max(200),
      content: z.string().max(2_000_000), // 2 MB cap for inline text creation
      confirm: z.boolean().optional(),
    });
    const parsed = TextBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
    }
    const buf = Buffer.from(parsed.data.content, 'utf8');
    await guardNewFileIn(user.id, parsed.data.parentPath, parsed.data.filename, {
      confirm: parsed.data.confirm === true && callerMayConfirm(),
    });
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
    if (err instanceof TreeVisibilityError || isBusy(err)) return treeErrorResponse(err);
    const msg = errorMessage(err);
    if (isUniqueViolation(err)) {
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
async function tryUtf8SnippetFromDisk(
  parentPath: string,
  filename: string,
): Promise<string | undefined> {
  const p = diskPathForFile(parentPath, filename);
  if (!p) return undefined;
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(p, 'r');
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(2048), 0, 2048, 0);
    return tryUtf8Snippet(buffer.subarray(0, bytesRead));
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

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
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
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
