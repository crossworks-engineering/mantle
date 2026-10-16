import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { capped } from '@/lib/list-workspaces';
import { callerMayConfirm, callerMayReadEmail } from '@/lib/api-v1';
import { ownerCaller } from '@/lib/auth';
import { allPrivateRows, listStateOf } from '@/lib/admin-private-rows';
import { ensureFilesRootBranch, listFiles, listRecentFiles, upsertFile } from '@/lib/files';
import {
  emailAttachmentIds,
  reachesEmailAttachment,
  diskPathForFile,
  discardSpooled,
  maxStreamedUploadBytes,
  sweepSpool,
  FILES_ROOT_LABEL,
} from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import { promises as fs } from 'node:fs';
import { readMultipartUpload, type ParsedUpload } from '@/lib/upload-stream';
import { firstIssue } from '@/lib/zod-issue';
import { conflictOnUnique } from '@mantle/db';
import { guardNewFileIn } from '@mantle/content/tree';
import { JSON_BODY_CEILING_BYTES } from '@/lib/body-limit';
import { readJson } from '@/lib/read-body';

const ListQuery = z.union([
  z.object({ parent: z.string().min(1).max(500) }),
  // Cross-tree recency view — the left pane's "Recent" entry. Rows carry
  // parentPath, so the client can show where each file lives.
  z.object({ recent: z.literal('1'), limit: z.coerce.number().int().min(1).max(200).optional() }),
]);

export async function GET(req: Request) {
  const user = ownerCaller();
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
    return NextResponse.json({ files: await capped(files) });
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
  return NextResponse.json({ files: await capped(files) });
}

/**
 * An API key without the Search area does not write into a mail's
 * attachments folder (access matrix M4, audit LOW-3): with `replace=true` it
 * would overwrite an attachment, and a 409 on a taken name would tell it
 * which attachments exist. MCP refuses the same (key-email-guard.ts).
 */
async function mailFolderRefusal(ownerId: string, parentPath: string): Promise<Response | null> {
  if (callerMayReadEmail()) return null;
  if (!(await reachesEmailAttachment(ownerId, { path: parentPath }))) return null;
  return NextResponse.json(
    { error: 'This key reaches email only with the Search area.' },
    { status: 403 },
  );
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
  const user = ownerCaller();
  await ensureFilesRootBranch(user.id);
  const contentType = req.headers.get('content-type') ?? '';
  const multipart = contentType.includes('multipart/form-data');
  // The JSON body (an inline text file): this upload path has no loader
  // ceiling (its multipart upload streams under its own cap), so the read
  // takes the JSON one (A10 part 2). Read before the try below, whose catch
  // answers the write's errors, not the body's.
  const raw = multipart ? null : await readJson(req, { maxBytes: JSON_BODY_CEILING_BYTES });

  // A slug or name taken answers 409 with this route's own text
  // (conflictOnUnique, a ConflictError); anything else answers by the one
  // table (A10 part 2): a domain error its status, a fault the opaque 500.
  return conflictOnUnique('a file with that name already exists in this folder', async () => {
    if (multipart) {
      // Streamed: the body spools to disk as it arrives (see lib/upload-stream),
      // so the cap here is a disk/UX number, not a memory one: the old
      // `req.formData()` path buffered the whole file (and a copy) before it
      // could even say "too large".
      void sweepSpool();
      const maxBytes = maxStreamedUploadBytes();
      // Over the cap (UploadTooLargeError): 413 with the cap, by the one
      // table (A10 part 2); a malformed body is an InputError (400, the
      // parser's text); a spool that failed is a fault.
      const parsed: ParsedUpload = await readMultipartUpload(req, { maxBytes });
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
      const mail = await mailFolderRefusal(user.id, parentPath);
      if (mail) {
        await discardSpooled(upload.spooled);
        return mail;
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
    const mail = await mailFolderRefusal(user.id, parsed.data.parentPath);
    if (mail) return mail;
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
  });
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
  const user = ownerCaller();
  // No loader ceiling on this path (the upload's): the JSON one (A10 part 2).
  const raw = await readJson(req, { maxBytes: JSON_BODY_CEILING_BYTES });
  const parsed = BulkDeleteBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  if (parsed.data.cascade) {
    const { deleteFileWithDerived } = await import('@mantle/content');
    const { bulkDeleteGate, bulkRefusalOf } = await import('@/lib/files');
    // Every id passes the item check first, and each one not deleted is
    // reported (F4 fix round 2: they were left out, silently).
    const { allowed, refused } = await bulkDeleteGate(parsed.data.ids);
    let deleted = 0;
    let reapedTotal = 0;
    for (const id of allowed) {
      const res = await deleteFileWithDerived(user.id, id);
      if (res.ok) deleted++;
      else refused.push(bulkRefusalOf(id, res));
      reapedTotal += res.reaped.total;
    }
    return NextResponse.json({ deleted, hasDerived: [], reapedTotal, refused });
  }
  const { bulkDeleteFiles } = await import('@/lib/files');
  const res = await bulkDeleteFiles({ ownerId: user.id, fileIds: parsed.data.ids });
  return NextResponse.json(res);
}
