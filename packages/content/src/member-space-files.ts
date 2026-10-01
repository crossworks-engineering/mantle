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
  pages,
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
  MEMBER_SPACE_LIMITS,
  clientSpacesTotalBytes,
  inClientSpace,
  spaceLimits,
} from './space-limits';
import {
  assertItemRoom,
  lockSpaceQuota,
  quotaRefusal,
  requireSpace,
  spaceNotFound,
} from './member-space-core';
import { notifySpaceItemChanged } from './member-space-events';
import { dedupeFilename } from './dedupe-filename';

/** The ltree path every personal file node carries (not under `files`). */
export const SPACE_FILES_PATH = 'space_files';

/** One upload's ceiling for a member (the admin's streamed cap is 512 MB).
 *  A client's space has its own, lower limits (space-limits.ts): code that
 *  enforces a limit reads `spaceLimits()`, never these. */
export const SPACE_FILE_MAX_BYTES = MEMBER_SPACE_LIMITS.fileMaxBytes;
/** Everything a member's space holds on disk: file bytes plus table workbooks. */
export const SPACE_STORAGE_LIMIT_BYTES = MEMBER_SPACE_LIMITS.storageBytes;
/** New file bytes a member's space may take in 24 hours. */
export const SPACE_DAILY_UPLOAD_BYTES = MEMBER_SPACE_LIMITS.dailyUploadBytes;

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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Where a quota read runs: the caller's scope (`db`), or an explicit
 *  transaction (give back, on the admin pool, sees its own moves). */
type Via = Pick<Tx, 'select' | 'execute'>;

/**
 * Bytes a space holds: its files, its table workbooks (their unsaved drafts
 * included: a draft grows by op batches until Save), and the text of its
 * pages (saved doc, draft and plain text) and notes, as stored (client
 * logins C5 audit, I3: text is not free). The same sums as
 * mantle_client_space_usage() (migration 0195), plus the table drafts on
 * disk.
 */
export async function spaceStorageUsed(spaceId: string, via: Via = db): Promise<number> {
  const [f] = await via
    .select({
      n: sql<string>`coalesce(sum(case ${nodes.type}
             when 'file' then coalesce((${nodes.data}->>'size_bytes')::bigint, 0)
             when 'note' then pg_column_size(${nodes.data})::bigint
             else 0 end), 0)`,
    })
    .from(nodes)
    .where(eq(nodes.ownerId, spaceId));
  const [p] = await via
    .select({
      n: sql<string>`coalesce(sum(pg_column_size(${pages.doc})::bigint
             + coalesce(pg_column_size(${pages.draftDoc}), 0)
             + pg_column_size(${pages.docText})), 0)`,
    })
    .from(pages)
    .innerJoin(nodes, eq(nodes.id, pages.nodeId))
    .where(eq(nodes.ownerId, spaceId));
  const workbooks = await via
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
  return Number(f?.n ?? 0) + Number(p?.n ?? 0) + t;
}

/** The stored bytes of one item's text: a page's doc, draft and plain text,
 *  or a note's data. Zero for any other kind. */
async function itemTextBytes(id: string): Promise<number> {
  const rows = (await db.execute(sql`
    select coalesce((select pg_column_size(p.doc)::bigint
                            + coalesce(pg_column_size(p.draft_doc), 0)
                            + pg_column_size(p.doc_text)
                       from pages p where p.node_id = ${id}), 0)
         + coalesce((select pg_column_size(n.data)::bigint
                       from nodes n where n.id = ${id} and n.type = 'note'), 0) as n`)) as unknown as {
    n: string | number | null;
  }[];
  return Number(rows[0]?.n ?? 0);
}

/**
 * Run a text write (a page's draft, Save version or create, a note's text)
 * under the CLIENT's storage limits (audit I3): page and note text count
 * toward the 200 MB of the space and the brain-wide client total. The write
 * runs first; when it made the item's stored text larger, the limits are
 * checked under the quota locks with the write in place, and a space (or
 * total) now over its limit is refused (409 `quota`), rolling the write back
 * with the space transaction. A write that shrinks or keeps the text always
 * passes, so a client over the limit can still cut a page down. A member's
 * space runs `write` unchecked. `id` null: a new item (`write` answers its
 * id).
 */
export async function withClientTextRoom<T>(
  spaceId: string,
  id: string | null,
  write: () => Promise<T>,
  idOf?: (res: T) => string | null,
): Promise<T> {
  requireSpace(spaceId);
  if (!inClientSpace()) return write();
  const before = id ? await itemTextBytes(id) : 0;
  const res = await write();
  const target = id ?? idOf?.(res) ?? null;
  if (target && (await itemTextBytes(target)) > before) await assertSpaceStorage(spaceId);
  return res;
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
  const limits = spaceLimits();
  const [used, today] = [await spaceStorageUsed(spaceId), await uploadedToday(spaceId)];
  // A client's space also shares the brain-wide client total (N12).
  const clientsLeft = inClientSpace()
    ? clientSpacesTotalBytes() - (await clientSpacesUsed())
    : Number.POSITIVE_INFINITY;
  return Math.max(
    0,
    Math.min(
      limits.fileMaxBytes,
      limits.storageBytes - used,
      limits.dailyUploadBytes - today,
      clientsLeft,
    ),
  );
}

/** Bytes every client space of the brain holds together (files, table
 *  workbooks, page and note text), a former client's until its purge
 *  (migration 0195). A security-definer function: a client's space role
 *  reads no other space, and it answers one number. */
export async function clientSpacesUsed(via: Via = db): Promise<number> {
  const rows = (await via.execute(
    sql`select mantle_client_space_bytes()::text as n`,
  )) as unknown as { n: string | null }[];
  return Number(rows[0]?.n ?? 0);
}

/** Serialize the client total across ALL client spaces (like the space's own
 *  quota lock): two clients' uploads must not both pass the last headroom. */
export async function lockClientTotal(via: Via = db): Promise<void> {
  await via.execute(sql`select pg_advisory_xact_lock(hashtextextended('client-spaces-total', 0))`);
}

/**
 * Refuse a write that would take the space past its storage limit (409
 * `quota`). `incoming` is what the write adds, as far as the caller knows it
 * (a table op batch is bounded by its request, so the space may overshoot by
 * one request at most). Takes the space's quota lock first.
 */
export async function assertSpaceStorage(spaceId: string, incoming = 0): Promise<void> {
  requireSpace(spaceId);
  const limits = spaceLimits();
  await lockSpaceQuota(spaceId);
  if ((await spaceStorageUsed(spaceId)) + incoming > limits.storageBytes) {
    throw await quotaRefusal(
      'storage',
      `Your space is full (${mb(limits.storageBytes)}). Delete something first.`,
    );
  }
  if (inClientSpace()) {
    await lockClientTotal();
    if ((await clientSpacesUsed()) + incoming > clientSpacesTotalBytes()) {
      throw await quotaRefusal(
        'total',
        'The storage for client uploads is full. Ask your contact to make room.',
      );
    }
  }
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** The filenames this space's files already use in `path` (the unique index
 *  is per owner, path and exact filename). At most SPACE_ITEM_LIMIT rows. */
async function spaceFilenames(spaceId: string, path: string): Promise<Set<string>> {
  const rows = await db
    .select({ name: sql<string | null>`${nodes.data} ->> 'filename'` })
    .from(nodes)
    .where(
      and(eq(nodes.ownerId, spaceId), eq(nodes.type, 'file'), sql`${nodes.path}::text = ${path}`),
    );
  return new Set(rows.flatMap((r) => (r.name ? [r.name] : [])));
}

/**
 * Add an uploaded file to the caller's space: private, draft. The upload is
 * already spooled (and capped at SPACE_FILE_MAX_BYTES by the route). On any
 * refusal or failure the spool is removed; on a failed insert the adopted
 * bytes are removed again. Returns the new node id.
 */
export async function createMineFile(
  spaceId: string,
  /** `path`: a folder to file it in (a stored `space_files...` path the tree
   *  checked: memberFilingPath); the space's top level by default. */
  input: { filename: string; spooled: SpooledUpload; path?: string },
): Promise<string> {
  const { loginId } = requireSpace(spaceId);
  const { spooled } = input;
  let adopted = false;
  const id = randomUUID();
  try {
    const cleaned = cleanSpaceFilename(input.filename);
    if (!cleaned) throw new Error('invalid filename');
    const limits = spaceLimits();
    if (spooled.size > limits.fileMaxBytes) {
      throw await quotaRefusal('file-size', `Files can be at most ${mb(limits.fileMaxBytes)}.`);
    }
    // Locked (the space's quota lock, held to the end of the transaction):
    // a parallel create or upload at the last place waits here.
    await assertItemRoom(spaceId);
    // Locked: a parallel upload waits here until this transaction ends.
    await assertSpaceStorage(spaceId, spooled.size);
    if ((await uploadedToday(spaceId)) + spooled.size > limits.dailyUploadBytes) {
      throw await quotaRefusal(
        'daily-upload',
        `You can upload ${mb(limits.dailyUploadBytes)} a day. Try again tomorrow.`,
      );
    }
    // A second upload with a name the space already holds files as
    // `name-2.ext` (the Accept path's rule), not as a unique-index 500. The
    // storage lock above serialises this space's uploads, so the name holds.
    const path = input.path ?? SPACE_FILES_PATH;
    if (path !== SPACE_FILES_PATH && !path.startsWith(`${SPACE_FILES_PATH}.`)) {
      throw new Error('a file goes in a files folder');
    }
    const filename = dedupeFilename(cleaned, await spaceFilenames(spaceId, path));
    await adoptSpooledIntoSpace(spaceId, id, spooled);
    adopted = true;
    const extension = extOf(filename);
    await db.insert(nodes).values({
      id,
      ownerId: spaceId,
      type: 'file',
      title: filename,
      path,
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
