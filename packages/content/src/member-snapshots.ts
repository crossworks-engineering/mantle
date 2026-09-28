/**
 * The accepted snapshot (audit F07, option A; Jason 2026-09-28): at every
 * Accept of a member-authored item (a reviewed Accept, an Accept after Take
 * over, a left-behind Accept) the accepted SAVED version is recorded for its
 * author in `accepted_snapshots` (migration 0183). The author's reads of
 * their accepted items (member-accepted.ts) come from here, never from the
 * brain's current version: what an admin changes afterwards is the brain's.
 *
 *  - page: the committed document; note: its text;
 *  - drawing: the committed scene, its saved SVG and its image refs;
 *  - table: a copy of the published workbook (VACUUM INTO) under
 *    TABLE_DB_DIR/accepted-snapshots/<id>.sqlite, which the table backup
 *    takes with the rest (table-storage.ts); a table with no workbook keeps
 *    its document;
 *  - file: its sha256, name, type and size only. The bytes stay the brain's
 *    and are served to the author only while the brain file still has
 *    exactly those bytes (`acceptedFileUnchanged`).
 *
 * A snapshot the migration could not take in SQL (a pre-0183 file-backed
 * table, a file with no recorded sha256) is `pending`, and so is none at all
 * (an Accept made by older code): `snapshotOf` completes it from the brain's
 * current saved version on the author's first read.
 *
 * Admin pool only (the snapshot table has no grant below admin). Pure rows
 * and file copies: nothing here starts LLM work.
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { acceptedSnapshots, db, draws, nodes, pages, spaceItems, tables } from '@mantle/db';
import { diskPathForFile } from '@mantle/files';
import {
  publishedPath,
  relativeStoragePath,
  resolveStoragePath,
  snapshotFile,
} from '@mantle/tabledb';
import { SNAPSHOT_OWNER, removeTableFile } from './table-storage';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AcceptedSnapshot = typeof acceptedSnapshots.$inferSelect;

/** The owner segment the workbook copies live under, inside TABLE_DB_DIR. */
export const SNAPSHOT_TABLE_OWNER = SNAPSHOT_OWNER;

/** Where one accepted table's workbook copy lives. */
export function snapshotTableAbs(nodeId: string): string {
  return publishedPath(SNAPSHOT_TABLE_OWNER, nodeId);
}

/** A brain file's bytes on disk, hashed. Cached by path, size and mtime so
 *  a repeated read of an unchanged file costs one stat. */
const hashCache = new Map<string, string>();
const HASH_CACHE_MAX = 500;

async function hashFile(abs: string): Promise<string | null> {
  let key: string;
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return null;
    key = `${abs}\u0000${st.size}\u0000${st.mtimeMs}`;
  } catch {
    return null;
  }
  const hit = hashCache.get(key);
  if (hit) return hit;
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer);
  } catch {
    return null;
  }
  const sha = hash.digest('hex');
  if (hashCache.size >= HASH_CACHE_MAX) hashCache.clear();
  hashCache.set(key, sha);
  return sha;
}

/** A brain file node's bytes on disk, or null (not a brain file path). */
function brainFileAbs(node: { path: unknown; title: string; data: unknown }): string | null {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const name = typeof d.filename === 'string' && d.filename ? d.filename : node.title;
  return diskPathForFile(String(node.path), name);
}

/**
 * Record the snapshot of every item in `ids` that is accepted and member
 * authored (its `space_items` row says `accepted`), read on `tx` after the
 * move: the version the brain just got. A table's workbook is copied now
 * (`onRollback` removes the copy again). Replaces an earlier snapshot of the
 * same item, keeping its accept time.
 */
export async function writeAcceptedSnapshots(
  tx: Pick<Tx, 'select' | 'insert'>,
  brainId: string,
  ids: string[],
  hooks: { onRollback?: (() => Promise<unknown>)[] } = {},
): Promise<number> {
  if (!ids.length) return 0;
  const rows = await tx
    .select({
      node: nodes,
      acceptedAt: spaceItems.acceptedAt,
      pageDoc: pages.doc,
      pageVersion: pages.version,
      scene: draws.scene,
      sceneSvg: draws.sceneSvg,
      fileRefs: draws.fileRefs,
      drawVersion: draws.version,
      tableData: tables.data,
      tableVersion: tables.version,
      storagePath: tables.storagePath,
    })
    .from(nodes)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .leftJoin(pages, eq(pages.nodeId, nodes.id))
    .leftJoin(draws, eq(draws.nodeId, nodes.id))
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(
      and(
        inArray(nodes.id, ids),
        eq(nodes.ownerId, brainId),
        eq(spaceItems.reviewState, 'accepted'),
      ),
    );
  let n = 0;
  for (const r of rows) {
    const node = r.node;
    const d = (node.data ?? {}) as Record<string, unknown>;
    const base = {
      nodeId: node.id,
      kind: String(node.type),
      title: node.title,
      icon: typeof d.icon === 'string' && d.icon.trim() ? d.icon : null,
      version: null as number | null,
      doc: null as unknown,
      content: null as string | null,
      scene: null as unknown,
      sceneSvg: null as string | null,
      fileRefs: null as unknown,
      tablePath: null as string | null,
      tableDoc: null as unknown,
      fileSha256: null as string | null,
      fileName: null as string | null,
      fileMime: null as string | null,
      fileSize: null as number | null,
      acceptedAt: r.acceptedAt ?? new Date(),
      pending: false,
    };
    switch (node.type) {
      case 'page':
        base.version = r.pageVersion;
        base.doc = r.pageDoc;
        break;
      case 'note':
        base.content = typeof d.content === 'string' ? d.content : '';
        break;
      case 'draw':
        base.version = r.drawVersion;
        base.scene = r.scene;
        base.sceneSvg = r.sceneSvg;
        base.fileRefs = r.fileRefs;
        break;
      case 'table': {
        base.version = r.tableVersion;
        if (r.storagePath) {
          const dest = snapshotTableAbs(node.id);
          // VACUUM INTO: a consistent copy even with a WAL beside it.
          snapshotFile(resolveStoragePath(r.storagePath), dest);
          hooks.onRollback?.push(async () => removeTableFile(dest));
          base.tablePath = relativeStoragePath(SNAPSHOT_TABLE_OWNER, node.id);
        } else {
          base.tableDoc = r.tableData;
        }
        break;
      }
      case 'file': {
        base.fileName = typeof d.filename === 'string' && d.filename ? d.filename : node.title;
        base.fileMime = typeof d.mime_type === 'string' ? d.mime_type : null;
        base.fileSize = Number(d.size_bytes ?? 0) || null;
        // Recorded at upload (a personal file's bytes never change in its
        // space); else the brain file's bytes now, when they are in place.
        const recorded = typeof d.sha256 === 'string' && d.sha256 ? d.sha256 : null;
        const abs = recorded ? null : brainFileAbs(node);
        base.fileSha256 = recorded ?? (abs ? await hashFile(abs) : null);
        base.pending = !base.fileSha256;
        break;
      }
      default:
        continue;
    }
    const { nodeId, acceptedAt, ...rest } = base;
    await tx
      .insert(acceptedSnapshots)
      .values({ nodeId, acceptedAt, ...rest })
      .onConflictDoUpdate({ target: acceptedSnapshots.nodeId, set: rest });
    n++;
  }
  return n;
}

/**
 * The snapshot of an accepted item, completed first when it is pending or
 * missing (see the module comment). The CALLER has proved the author rule
 * (member-accepted.ts); this only reads and completes. Null when the item is
 * not an accepted brain item any more.
 */
export async function snapshotOf(brainId: string, id: string): Promise<AcceptedSnapshot | null> {
  const [snap] = await db
    .select()
    .from(acceptedSnapshots)
    .where(eq(acceptedSnapshots.nodeId, id))
    .limit(1);
  if (snap && !snap.pending) return snap;
  const onRollback: (() => Promise<unknown>)[] = [];
  try {
    return await db.transaction(async (tx) => {
      // One completion at a time per item: two first reads must not copy the
      // same workbook over each other.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`accepted-snapshot:${id}`}, 0))`,
      );
      const [again] = await tx
        .select()
        .from(acceptedSnapshots)
        .where(eq(acceptedSnapshots.nodeId, id))
        .limit(1);
      if (again && !again.pending) return again;
      await writeAcceptedSnapshots(tx, brainId, [id], { onRollback });
      const [done] = await tx
        .select()
        .from(acceptedSnapshots)
        .where(eq(acceptedSnapshots.nodeId, id))
        .limit(1);
      return done ?? null;
    });
  } catch (err) {
    for (const fn of onRollback) await fn().catch(() => {});
    throw err;
  }
}

/**
 * True while the brain file `id` still holds exactly the bytes its author's
 * snapshot records: the node's recorded sha256 AND the bytes on disk. False
 * once an admin replaced or edited it (or the bytes are gone).
 */
export async function acceptedFileUnchanged(
  brainId: string,
  id: string,
  snap: Pick<AcceptedSnapshot, 'fileSha256'>,
): Promise<boolean> {
  if (!snap.fileSha256) return false;
  const [node] = await db
    .select({ path: nodes.path, title: nodes.title, data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, brainId), eq(nodes.type, 'file')))
    .limit(1);
  if (!node) return false;
  const d = (node.data ?? {}) as Record<string, unknown>;
  if (typeof d.sha256 === 'string' && d.sha256 !== snap.fileSha256) return false;
  const abs = brainFileAbs(node);
  return abs !== null && (await hashFile(abs)) === snap.fileSha256;
}

/**
 * True while the brain drawing `id` is still at the version its author's
 * snapshot records (for a snapshot with no saved SVG of its own).
 */
export async function acceptedDrawUnchanged(
  brainId: string,
  id: string,
  snap: Pick<AcceptedSnapshot, 'version'>,
): Promise<boolean> {
  if (snap.version === null) return false;
  const [row] = await db
    .select({ version: draws.version })
    .from(draws)
    .innerJoin(nodes, eq(nodes.id, draws.nodeId))
    .where(and(eq(draws.nodeId, id), eq(nodes.ownerId, brainId)))
    .limit(1);
  return row?.version === snap.version;
}
