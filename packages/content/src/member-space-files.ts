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
import { db, nodes, spaceItems, tables } from '@mantle/db';
import {
  adoptSpooledIntoSpace,
  extOf,
  mimeForExt,
  openSpaceFile,
  removeSpaceFile,
  type SpooledUpload,
} from '@mantle/files';
import { promises as fs, type ReadStream } from 'node:fs';
import {
  SpaceItemStateError,
  assertItemRoom,
  requireSpace,
  spaceNotFound,
} from './member-space-core';

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

/** A display filename: the last path segment, no control characters,
 *  trimmed and bounded. Case and spaces are kept (it is a name a person
 *  reads; the bytes are stored by id, so it is never a path). */
export function cleanSpaceFilename(raw: string): string | null {
  const base = raw.replace(/^.*[\\/]/, '');
  const clean = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
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

/** Bytes a space holds on disk: its files plus its table workbooks. */
export async function spaceStorageUsed(spaceId: string): Promise<number> {
  const [f] = await db
    .select({
      n: sql<string>`coalesce(sum((${nodes.data}->>'size_bytes')::bigint), 0)`,
    })
    .from(nodes)
    .where(and(eq(nodes.ownerId, spaceId), eq(nodes.type, 'file')));
  const [t] = await db
    .select({ n: sql<string>`coalesce(sum(${tables.sizeBytes}), 0)` })
    .from(tables)
    .innerJoin(nodes, eq(nodes.id, tables.nodeId))
    .where(eq(nodes.ownerId, spaceId));
  return Number(f?.n ?? 0) + Number(t?.n ?? 0);
}

async function uploadedToday(spaceId: string): Promise<number> {
  const [r] = await db
    .select({
      n: sql<string>`coalesce(sum((${nodes.data}->>'size_bytes')::bigint), 0)`,
    })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, spaceId),
        eq(nodes.type, 'file'),
        gt(nodes.createdAt, sql`now() - interval '24 hours'`),
      ),
    );
  return Number(r?.n ?? 0);
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
    if ((await spaceStorageUsed(spaceId)) + spooled.size > SPACE_STORAGE_LIMIT_BYTES) {
      throw new SpaceItemStateError(
        'quota',
        `Your space is full (${mb(SPACE_STORAGE_LIMIT_BYTES)}). Delete something first.`,
      );
    }
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
  await removeSpaceFile(spaceId, id);
  return true;
}

export type OpenedSpaceFile = { file: SpaceFile; stream: ReadStream; size: number };

/** An own file's bytes, or null when it is not the caller's (or gone). */
export async function openMineFile(spaceId: string, id: string): Promise<OpenedSpaceFile | null> {
  requireSpace(spaceId);
  const file = await spaceFileOf(spaceId, id);
  if (!file) return null;
  const opened = await openSpaceFile(spaceId, id);
  return opened ? { file, ...opened } : null;
}
