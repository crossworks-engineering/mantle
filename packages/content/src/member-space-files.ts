/**
 * Files in a personal space (member logins Phase 2, plan v3.1 sections 2 and
 * 8). The node lives in the member's space like any other personal item; the
 * bytes live under the spaces root, keyed by space and node id
 * (@mantle/files space-disk.ts), never in the brain's mirrored files tree.
 *
 * A personal file's node path is `space_files`, which is not under `files`:
 * every brain file helper (disk path resolvers, readFileById, the watcher,
 * the extractor) resolves nothing for it. Its bytes are read only here, for
 * its own space, or for a teammate when it is shared with the team.
 *
 * Nothing learns: no text extraction, no chunks, no embedding (read, never
 * learn). Quotas (section 8) are checked before the bytes are adopted.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import {
  afterCommit,
  afterRollback,
  db,
  nodes,
  spaceItems,
  spaceUploads,
  tables,
} from '@mantle/db';
import {
  adoptSpooledIntoSpace,
  extOf,
  mimeForExt,
  openSpaceFile,
  removeSpaceFile,
  type SpooledUpload,
} from '@mantle/files';
import { existsSync, promises as fs, statSync, type ReadStream } from 'node:fs';
import { draftAbsFor } from './table-storage';
import {
  SpaceItemStateError,
  assertItemRoom,
  lockSpaceQuota,
  requireSpace,
  spaceNotFound,
} from './member-space-core';
import { notifySpaceItemChanged } from './member-space-events';

/** The ltree path every personal file node carries (not under `files`). */
export const SPACE_FILES_PATH = 'space_files';

/** One upload's ceiling for a member (the admin's streamed cap is 512 MB). */
export const SPACE_FILE_MAX_BYTES = 100 * 1024 * 1024;
/** Everything a space holds on disk: file bytes plus table workbooks. */
export const SPACE_STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
/** New file bytes a space may take in 24 hours. */
export const SPACE_DAILY_UPLOAD_BYTES = 500 * 1024 * 1024;

export type SpaceFile = {
  id: string;
  filename: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
};

function fileOf(node: typeof nodes.$inferSelect): SpaceFile {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const filename = typeof d.filename === 'string' && d.filename ? d.filename : node.title;
  const extension = typeof d.extension === 'string' ? d.extension : extOf(filename);
  return {
    id: node.id,
    filename,
    extension,
    mimeType: typeof d.mime_type === 'string' ? d.mime_type : mimeForExt(extension),
    sizeBytes: Number(d.size_bytes ?? 0),
    sha256: typeof d.sha256 === 'string' ? d.sha256 : null,
  };
}

/** A display filename: the last path segment, no control characters and no
 *  invisible direction or zero-width marks (`invoice` + U+202E + `fdp.exe`
 *  reads as `invoiceexe.pdf`), trimmed and bounded. Case and spaces are kept
 *  (it is a name a person reads; the bytes are stored by id, so it is never
 *  a path). */
export function cleanSpaceFilename(raw: string): string | null {
  const base = raw.replace(/^.*[\\/]/, '');
  const clean = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim()
    .slice(0, 200);
  return clean && clean !== '.' && clean !== '..' ? clean : null;
}

/** A personal file's metadata, for the space that owns it. */
export async function spaceFileOf(ownerId: string, id: string): Promise<SpaceFile | null> {
  const [n] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'file')))
    .limit(1);
  return n ? fileOf(n) : null;
}

/** Bytes a space holds on disk: its files plus its table workbooks, their
 *  unsaved drafts included (a draft grows by op batches until Save). */
export async function spaceStorageUsed(spaceId: string): Promise<number> {
  const [f] = await db
    .select({
      n: sql<string>`coalesce(sum((${nodes.data}->>'size_bytes')::bigint), 0)`,
    })
    .from(nodes)
    .where(and(eq(nodes.ownerId, spaceId), eq(nodes.type, 'file')));
  const workbooks = await db
    .select({ size: tables.sizeBytes, storagePath: tables.storagePath })
    .from(tables)
    .innerJoin(nodes, eq(nodes.id, tables.nodeId))
    .where(eq(nodes.ownerId, spaceId));
  let t = 0;
  for (const w of workbooks) {
    t += Number(w.size ?? 0);
    if (!w.storagePath) continue;
    const draft = draftAbsFor(w.storagePath);
    if (existsSync(draft)) t += statSync(draft).size;
  }
  return Number(f?.n ?? 0) + t;
}

/** Bytes uploaded to a space in the last 24 hours, from the upload ledger:
 *  a deleted file still counts, so upload-delete-upload cannot reset it. */
async function uploadedToday(spaceId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<string>`coalesce(sum(${spaceUploads.bytes}), 0)` })
    .from(spaceUploads)
    .where(
      and(
        eq(spaceUploads.spaceId, spaceId),
        gt(spaceUploads.createdAt, sql`now() - interval '24 hours'`),
      ),
    );
  return Number(r?.n ?? 0);
}

/**
 * How many bytes the space may still take in one upload now: the smallest of
 * the per-file cap, the storage left and today's upload budget left. The
 * upload route compares the request's Content-Length with it BEFORE the body
 * is spooled.
 */
export async function spaceUploadHeadroom(spaceId: string): Promise<number> {
  requireSpace(spaceId);
  const [used, today] = [await spaceStorageUsed(spaceId), await uploadedToday(spaceId)];
  return Math.max(
    0,
    Math.min(
      SPACE_FILE_MAX_BYTES,
      SPACE_STORAGE_LIMIT_BYTES - used,
      SPACE_DAILY_UPLOAD_BYTES - today,
    ),
  );
}

/**
 * Refuse a write that would take the space past its storage limit (409
 * `quota`). `incoming` is what the write adds, as far as the caller knows it
 * (a table op batch is bounded by its request, so the space may overshoot by
 * one request at most). Takes the space's quota lock first.
 */
export async function assertSpaceStorage(spaceId: string, incoming = 0): Promise<void> {
  requireSpace(spaceId);
  await lockSpaceQuota(spaceId);
  if ((await spaceStorageUsed(spaceId)) + incoming > SPACE_STORAGE_LIMIT_BYTES) {
    throw new SpaceItemStateError(
      'quota',
      `Your space is full (${mb(SPACE_STORAGE_LIMIT_BYTES)}). Delete something first.`,
    );
  }
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/**
 * Add an uploaded file to the caller's space: private, draft. The upload is
 * already spooled (and capped at SPACE_FILE_MAX_BYTES by the route). On any
 * refusal or failure the spool is removed; on a failed insert the adopted
 * bytes are removed again. Returns the new node id.
 */
export async function createMineFile(
  spaceId: string,
  input: { filename: string; spooled: SpooledUpload },
): Promise<string> {
  const { loginId } = requireSpace(spaceId);
  const { spooled } = input;
  let adopted = false;
  const id = randomUUID();
  try {
    const filename = cleanSpaceFilename(input.filename);
    if (!filename) throw new Error('invalid filename');
    if (spooled.size > SPACE_FILE_MAX_BYTES) {
      throw new SpaceItemStateError('quota', `Files can be at most ${mb(SPACE_FILE_MAX_BYTES)}.`);
    }
    await assertItemRoom(spaceId);
    // Locked: a parallel upload waits here until this transaction ends.
    await assertSpaceStorage(spaceId, spooled.size);
    if ((await uploadedToday(spaceId)) + spooled.size > SPACE_DAILY_UPLOAD_BYTES) {
      throw new SpaceItemStateError(
        'quota',
        `You can upload ${mb(SPACE_DAILY_UPLOAD_BYTES)} a day. Try again tomorrow.`,
      );
    }
    await adoptSpooledIntoSpace(spaceId, id, spooled);
    adopted = true;
    const extension = extOf(filename);
    await db.insert(nodes).values({
      id,
      ownerId: spaceId,
      type: 'file',
      title: filename,
      path: SPACE_FILES_PATH,
      data: {
        filename,
        extension,
        mime_type: mimeForExt(extension),
        size_bytes: spooled.size,
        sha256: spooled.sha256,
        storage: 'space',
      },
      tags: ['file'],
    });
    await db.insert(spaceItems).values({ nodeId: id, authorLoginId: loginId });
    await db.insert(spaceUploads).values({ spaceId, bytes: spooled.size });
    await notifySpaceItemChanged(id, 'created', { spaceId, team: false });
    // The rows commit with the caller's space transaction, not here: if it
    // rolls back later, the adopted bytes would be an orphan nobody counts.
    afterRollback(() => removeSpaceFile(spaceId, id));
    return id;
  } catch (err) {
    if (adopted) await removeSpaceFile(spaceId, id).catch(() => {});
    else await fs.unlink(spooled.tempPath).catch(() => {});
    throw err;
  }
}

/** Rename an own file (metadata only: the bytes are stored by id). The
 *  extension stays unless the new name brings one. */
export async function renameMineFile(spaceId: string, id: string, title: string): Promise<void> {
  requireSpace(spaceId);
  const [n] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, spaceId), eq(nodes.type, 'file')))
    .limit(1);
  if (!n) throw spaceNotFound();
  let name = cleanSpaceFilename(title);
  if (!name) return; // an empty name keeps the old one
  const old = fileOf(n);
  if (!extOf(name) && old.extension) name = `${name}.${old.extension}`.slice(0, 200);
  const extension = extOf(name);
  await db
    .update(nodes)
    .set({
      title: name,
      data: {
        ...((n.data ?? {}) as Record<string, unknown>),
        filename: name,
        extension,
        mime_type: mimeForExt(extension),
      },
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id));
}

/** Delete an own file: the node (and its space_items row), then the bytes.
 *  Frozen items are refused before this by the caller (assertEditable). */
export async function deleteMineFile(spaceId: string, id: string): Promise<boolean> {
  requireSpace(spaceId);
  const gone = await db
    .delete(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, spaceId), eq(nodes.type, 'file')))
    .returning({ id: nodes.id });
  if (!gone.length) return false;
  // The bytes go once the delete has COMMITTED: this runs inside the space
  // transaction, and a later failure there keeps the row, which then needs
  // its bytes.
  await afterCommit(() => removeSpaceFile(spaceId, id));
  return true;
}

export type OpenedSpaceFile = {
  file: SpaceFile;
  /** The space that holds the bytes (the author's, for a teammate's file). */
  spaceId: string;
  stream: ReadStream;
  size: number;
};

/** An own file's bytes, or null when it is not the caller's (or gone). */
export async function openMineFile(spaceId: string, id: string): Promise<OpenedSpaceFile | null> {
  requireSpace(spaceId);
  const file = await spaceFileOf(spaceId, id);
  if (!file) return null;
  const opened = await openSpaceFile(spaceId, id);
  return opened ? { file, spaceId, ...opened } : null;
}
