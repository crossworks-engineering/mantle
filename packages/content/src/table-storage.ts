import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import {
  acceptedSnapshots,
  currentWorkspaceScope,
  db,
  draftAllowed,
  nodes,
  markedBefore,
  readsDrafts,
  removeSqliteFile,
  revisionFiles,
  tables,
} from '@mantle/db';
import {
  ENGINE_VERSION,
  MATERIALIZE_MAX,
  TableFileMissingError,
  describeWorkbook,
  profileFile,
  profileToText,
  readDocClipped,
  resolveStoragePath,
  tableDbRoot,
  type WorkbookStats,
  type WorkbookTabRef,
} from '@mantle/tabledb';

import { ensureTableDoc, type TableDoc } from '@mantle/content-core/table-model';
import { tableToText } from './table-to-text';
import { errorMessage } from '@mantle/std';
import { copySqliteFile, linkHistoryTree } from './history-files';
import { flipTable, stageDoc, stagedTableWrite, tableRevisionPath } from './table-broker';

/**
 * File-side plumbing for sqlite-native tables (Tables v2 P1) — the pieces
 * tables.ts composes:
 *
 *   - the REGISTRY LOCK SPINE (plan §3.3): every draft-create, draft write
 *     batch, commit, and (later) migration step takes a Postgres row lock on
 *     the `tables` registry row for the duration of the file operation. WAL
 *     covers intra-process concurrency; this lock is the cross-process writer
 *     coordinator — and it is what makes commit's atomic rename safe.
 *   - doc loading with draft-first semantics off the workbook files.
 *   - file cleanup that also sweeps the -wal/-shm sidecars.
 *
 * P1 tab naming: every workbook has the single engine-default tab; multi-tab
 * arrives with un-split imports (P3) on the same layout.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LockedRegistryRow = {
  shapeHash: string | null;
  storagePath: string | null;
  draftRev: number;
  /** True row count from registry stats (null when never computed). */
  totalRows: number | null;
  /** Tab count from registry stats (null when never computed). Whole-doc
   *  writers use it to refuse single-tab payloads that would drop tabs. */
  tabCount: number | null;
} | null;

/**
 * Run `fn` while holding SELECT … FOR UPDATE on the table's registry row.
 * Serializes cross-process writers (UI autosave vs agent tool vs migration);
 * the lock releases when the transaction commits/rolls back. The locked row's
 * coordination fields are passed to `fn` (null when the sidecar is missing) —
 * commit uses shapeHash to decide whether the LLM re-summarize is due.
 */
export async function withTableRegistryLock<T>(
  nodeId: string,
  fn: (tx: Tx, locked: LockedRegistryRow) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const result = await tx.execute<{
      shape_hash: string | null;
      storage_path: string | null;
      draft_rev: number;
      total_rows: string | null;
      tab_count: number | null;
    }>(
      sql`SELECT shape_hash, storage_path, draft_rev, stats->>'totalRows' AS total_rows,
                 jsonb_array_length(stats->'tabs') AS tab_count
          FROM tables WHERE node_id = ${nodeId} FOR UPDATE`,
    );
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as {
      shape_hash: string | null;
      storage_path: string | null;
      draft_rev: number;
      total_rows: string | null;
      tab_count: number | null;
    }[];
    const locked: LockedRegistryRow = rows[0]
      ? {
          shapeHash: rows[0].shape_hash,
          storagePath: rows[0].storage_path,
          draftRev: Number(rows[0].draft_rev),
          totalRows: rows[0].total_rows == null ? null : Number(rows[0].total_rows),
          tabCount: rows[0].tab_count == null ? null : Number(rows[0].tab_count),
        }
      : null;
    return fn(tx, locked);
  });
}

export type LoadedDocs = {
  data: TableDoc;
  draft: TableDoc | null;
  /** True row counts in the files (docs may be clipped windows). */
  totalRows: number;
  draftTotalRows: number | null;
  /** data/draft.rows were clipped at the materialize window — page the rest
   *  via the rows route / listRowsWindow. */
  docClipped: boolean;
};

/** Published + draft docs off the workbook file, CLIPPED at the materialize
 *  window (un-split imports can exceed it). Missing published file throws
 *  TableFileMissingError (never self-healed — durability gate 1); a missing
 *  draft file just means "no uncommitted edits". */
export function loadDocsFromFile(
  storagePath: string,
  draftPath: string | null,
  opts: { tabId?: string; publishedOnly?: boolean } = {},
): LoadedDocs {
  const abs = resolveStoragePath(storagePath);
  // A tab created in the DRAFT doesn't exist published yet — an empty doc is
  // the honest published view of it (and vice versa below for the draft).
  let published: ReturnType<typeof readDocClipped>;
  try {
    published = readDocClipped(abs, MATERIALIZE_MAX, opts.tabId);
  } catch (err) {
    if (opts.tabId && err instanceof Error && /no tab/.test(err.message)) {
      published = {
        doc: { columns: [], rows: [], aggregates: {}, views: [] },
        total: 0,
        clipped: false,
      };
    } else {
      throw err;
    }
  }
  // The draft the row points at (store brokers, A3b): none, no draft.
  const draftAbs = draftAbsOf(draftPath);
  // A commit in the other process can consume the draft between the exists
  // check and the open — that's "no draft now", not an error (audit finding 7).
  // Below admin the draft is never read (member logins): a Library reader, a
  // teammate reading a shared table, or a team-level agent sees the published
  // workbook only. Only the owner and the item's own space read the draft,
  // and `publishedOnly` keeps it from a reader on the admin pool who must not
  // see it (the author of an accepted item, member-accepted.ts).
  let draftClipped: ReturnType<typeof readDocClipped> | null = null;
  // In a workspace scope (an Admin user's request) the draft is readable
  // only for an item the user may edit, which this function cannot see: the
  // caller asks the row (draftAllowed) and says so with publishedOnly: false.
  // Without that answer it reads the published workbook (W6a fix round 1).
  const mayReadDraft =
    opts.publishedOnly === false || (!opts.publishedOnly && !currentWorkspaceScope());
  if (mayReadDraft && readsDrafts() && draftAbs && existsSync(draftAbs)) {
    try {
      draftClipped = readDocClipped(draftAbs, MATERIALIZE_MAX, opts.tabId);
    } catch (err) {
      const draftLacksTab = opts.tabId && err instanceof Error && /no tab/.test(err.message);
      if (!draftLacksTab && !(err instanceof TableFileMissingError)) throw err;
    }
  }
  return {
    data: ensureTableDoc(published.doc),
    draft: draftClipped ? ensureTableDoc(draftClipped.doc) : null,
    totalRows: published.total,
    draftTotalRows: draftClipped?.total ?? null,
    docClipped: published.clipped || (draftClipped?.clipped ?? false),
  };
}

type EnsureFileNode = { id: string; ownerId: string; title: string };

/**
 * Lazy migration (P4, plan section 9): make a legacy JSONB table
 * file-backed. A store broker write (A3b, plan 20.3): the published
 * workbook from `data`, and a pending `draftData` as the draft IN THE SAME
 * STEP (stranding drafts was the data-loss hole), staged under new revision
 * names and row-count verified; then one short transaction checks the row
 * (still JSONB, at the revision read) and points it at them. No-op when
 * already file-backed. The table's revision moves by one.
 */
export async function ensureFileBacked(node: EnsureFileNode): Promise<void> {
  await stagedTableWrite(
    node.id,
    {},
    async (row) => {
      if (row.storagePath) return { files: [] as string[], skip: true as const };
      const [reg] = await db
        .select({ data: tables.data, draftData: tables.draftData })
        .from(tables)
        .where(eq(tables.nodeId, node.id))
        .limit(1);
      const doc = ensureTableDoc(reg?.data ?? { columns: [], rows: [] });
      const pubRel = tableRevisionPath(node.ownerId, node.id, false);
      const files: string[] = [];
      try {
        const pub = stageDoc(pubRel, doc, { nodeId: node.id, ownerId: node.ownerId, fts: true });
        files.push(pub.abs);
        const back = readDocClipped(pub.abs, 0);
        if (back.total !== doc.rows.length) {
          throw new Error(
            `table migration verify failed for ${node.id}: file has ${back.total} rows, JSONB has ${doc.rows.length}; kept on the JSONB path`,
          );
        }
        let draftRel: string | null = null;
        if (reg?.draftData != null) {
          draftRel = tableRevisionPath(node.ownerId, node.id, true);
          files.push(
            stageDoc(draftRel, ensureTableDoc(reg.draftData), {
              nodeId: node.id,
              ownerId: node.ownerId,
            }).abs,
          );
        }
        const dataText = buildTableDataText(pub.abs, doc, node.title);
        return { files, skip: false as const, pubRel, draftRel, pub, dataText };
      } catch (err) {
        files.forEach(removeSqliteFile);
        throw err;
      }
    },
    async (row, s) => {
      if (s.skip) return;
      await flipTable(node.id, row.draftRev, {
        dataText: s.dataText,
        ...registryFileColumns(s.pub.res, s.pubRel),
        ...(s.draftRel ? { draftPath: s.draftRel } : {}),
      });
    },
  );
}

/** The absolute path of the draft a row points at (`tables.draft_path`),
 *  or null: THE way a reader finds a table's draft (A3b). */
export function draftAbsOf(draftPath: string | null | undefined): string | null {
  return draftPath ? resolveStoragePath(draftPath) : null;
}

/** The registry columns a successful file write updates, in drizzle `set`
 *  shape — one place so create/draft/commit can't drift apart. */
export function registryFileColumns(
  res: { sizeBytes: number; stats: WorkbookStats; shapeHash: string },
  storagePath: string,
) {
  return {
    storagePath,
    sizeBytes: res.sizeBytes,
    stats: res.stats as unknown as Record<string, unknown>,
    shapeHash: res.shapeHash,
    engineVersion: ENGINE_VERSION,
  };
}

/** The SQL surface of an owned, file-backed table — what table_sql runs
 *  against and what table_get advertises. Null for legacy JSONB tables
 *  (any commit converts them). */
export async function tableSqlSurface(
  ownerId: string,
  nodeId: string,
): Promise<{
  abs: string;
  draftAbs: string | null;
  tabs: WorkbookTabRef[];
  draftOk: boolean;
} | null> {
  const [row] = await db
    .select({
      storagePath: tables.storagePath,
      draftPath: tables.draftPath,
      draftOk: draftAllowed(),
    })
    .from(tables)
    .innerJoin(nodes, eq(nodes.id, tables.nodeId))
    .where(and(eq(tables.nodeId, nodeId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row?.storagePath) return null;
  const abs = resolveStoragePath(row.storagePath);
  // draftOk: whether the caller may read the draft workbook (draftAllowed:
  // mantle_may_edit in a workspace scope, false below admin, W6a).
  return {
    abs,
    // The draft the row points at (A3b), only where the caller may read it.
    draftAbs: row.draftOk === true ? draftAbsOf(row.draftPath) : null,
    tabs: describeWorkbook(abs),
    draftOk: row.draftOk === true,
  };
}

/** How many leading rows land in dataText — list-ILIKE routing for
 *  identifier-shaped strings ONLY (§12.1 amendment: rows never reach
 *  content_chunks or embeddings; deep row lookup is table_sql's job). */
export const DATA_TEXT_ROW_WINDOW = 200;

/**
 * dataText for a file-backed table (plan §6 L3, as amended): the L1 profile
 * text + the first 200 rows as markdown with an honest truncation note.
 * Serves the tables-list ILIKE and the extractor's LLM input; the profile
 * part is also what write_chunks re-derives per tab. Reads everything from
 * the file, so it works on the promote path where no doc is materialized.
 * The `doc` param is accepted for callers that have one (ignored — kept so
 * call sites read naturally) — the file is always the source of truth here.
 */
export function buildTableDataText(
  publishedAbs: string,
  _doc: TableDoc | null,
  title: string,
): string {
  const profiles = profileFile(publishedAbs);
  const head = profileToText(profiles, { title });
  const total = profiles.reduce((a, t) => a + t.rowCount, 0);
  // The 200-row window spends across tabs in position order — a small tab
  // never starves the next one, and the truncation note stays honest.
  const parts: string[] = [];
  let budget = DATA_TEXT_ROW_WINDOW;
  let shown = 0;
  for (const tab of profiles) {
    if (budget <= 0) break;
    const window = readDocClipped(publishedAbs, budget, tab.tabId);
    if (window.doc.rows.length === 0 && profiles.length > 1) continue;
    const md = tableToText(ensureTableDoc(window.doc), {
      title: profiles.length > 1 ? `${title} — ${tab.name}` : title,
    });
    parts.push(md);
    budget -= window.doc.rows.length;
    shown += window.doc.rows.length;
  }
  const note =
    shown < total
      ? `\n\n(First ${shown} of ${total} rows shown — query the full data with table_sql.)`
      : '';
  return `${head}\n\n${parts.join('\n\n')}${note}`;
}

/**
 * Background migration sweep (P4, plan §9): convert up to `batch` legacy
 * JSONB tables to file storage. Each conversion takes the registry lock —
 * the same one every draft/commit writer takes — so the sweep can never fork
 * against a concurrent edit. Returns how many converted (0 = all done).
 */
export async function sweepLegacyTables(batch = 5): Promise<number> {
  const legacy = await db
    .select({ id: nodes.id, ownerId: nodes.ownerId, title: nodes.title })
    .from(nodes)
    .innerJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(eq(nodes.type, 'table'), sql`${tables.storagePath} IS NULL`))
    .limit(batch);
  let converted = 0;
  for (const n of legacy) {
    try {
      // A store broker write (A3b): its flip moves the table's revision, so
      // an editor open on the table sees a new revision once.
      await ensureFileBacked({ id: n.id, ownerId: n.ownerId, title: n.title });
      converted++;
    } catch (err) {
      // A failing table must not wedge the sweep — log and let the next tick
      // retry (the verify inside ensureFileBacked keeps it on the JSONB path).
      console.error(
        `[tables] migration sweep failed for ${n.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (converted > 0) console.log(`[tables] migration sweep converted ${converted} legacy table(s)`);
  return converted;
}

// ── Backup (durability gate 2) ───────────────────────────────────────────────

/** The owner segment, inside TABLE_DB_DIR, of the workbook copies member
 *  authors read their accepted tables from (member-snapshots.ts). */
export const SNAPSHOT_OWNER = 'accepted-snapshots';

/** A backup's options: `dumpStartedAt` (ms), when the Postgres dump the
 *  archive goes with started. Given, revisions the sweep had marked
 *  unreferenced before it are left out; without it, every revision goes. */
export type SnapshotAllOptions = { dumpStartedAt?: number };

export type TableDbSnapshotReport = {
  snapshotted: { ownerId: string; nodeId: string; bytes: number; draft: boolean }[];
  /** Registry rows whose published file is absent — already-lost data, NOT
   *  snapshotted (and exactly what the sanity check screams about). */
  missing: { nodeId: string; storagePath: string }[];
  failed: { nodeId: string; error: string }[];
};

/**
 * Consistent-snapshot EVERY file-backed table into destDir via VACUUM INTO,
 * mirroring the live <owner>/<node>.<revision>.sqlite layout so a restore
 * drops straight back into TABLE_DB_DIR. Every revision of a table on disk
 * goes (published and drafts, the ones its row names and the ones a flip
 * replaced since the Postgres dump; the sweep removes the extra ones after a
 * restore). Same contract as snapshotAllAppDatabases: report partial
 * failures loudly, never let a missing file look backed up.
 */
export async function snapshotAllTableDatabases(
  destDir: string,
  opts: SnapshotAllOptions = {},
): Promise<TableDbSnapshotReport> {
  // Bounded (A3b fix round 2): with the dump's start, a revision the sweep
  // had already marked unreferenced before it is left out (no restored row
  // can name it).
  const leaveOut =
    opts.dumpStartedAt !== undefined
      ? markedBefore(tableDbRoot(), opts.dumpStartedAt)
      : () => false;
  const rows = await db
    .select({
      nodeId: tables.nodeId,
      ownerId: nodes.ownerId,
      storagePath: tables.storagePath,
      draftPath: tables.draftPath,
    })
    .from(tables)
    .innerJoin(nodes, eq(nodes.id, tables.nodeId))
    .where(and(isNotNull(tables.storagePath)));

  // The workbook copies member authors read their accepted tables from
  // (audit F07, member-snapshots.ts): kept under their own owner segment,
  // so an untar into TABLE_DB_DIR puts them back where they were.
  const snaps = await db
    .select({ nodeId: acceptedSnapshots.nodeId, storagePath: acceptedSnapshots.tablePath })
    .from(acceptedSnapshots)
    .where(isNotNull(acceptedSnapshots.tablePath));
  const all = [
    ...rows.map((r) => ({ ...r, snapshot: false })),
    ...snaps.map((r) => ({ ...r, draftPath: null, ownerId: SNAPSHOT_OWNER, snapshot: true })),
  ];

  const report: TableDbSnapshotReport = { snapshotted: [], missing: [], failed: [] };
  // The tables' own history (apps plan Phase 4, table-snapshots.ts) rides
  // along: immutable files, hard-linked (no disk, no copy; apps audit
  // 2026-10-02, item 5).
  const history = path.join(tableDbRoot(), '_snapshots');
  if (existsSync(history)) {
    try {
      await linkHistoryTree(history, path.join(destDir, '_snapshots'));
    } catch (err) {
      report.failed.push({ nodeId: '_snapshots', error: errorMessage(err) });
    }
  }
  for (const r of all) {
    const storagePath = r.storagePath!;
    let abs: string;
    let files: { abs: string; rel: string }[];
    try {
      abs = resolveStoragePath(storagePath);
      // EVERY revision of the table on disk, not only the ones the row
      // names now (A3b fix round 1, H1): the Postgres dump ran first, and a
      // flip since then left the revision the dump names beside the new one
      // (the sweep keeps it for a grace period), so the archive holds the
      // file a restored row points at. Each under its own folder: a table
      // folded in from a member's space (W6b) keeps its files there, and a
      // draft can sit in another folder than the published file.
      const named = [storagePath, ...(r.draftPath ? [r.draftPath] : [])];
      const seen = new Set<string>();
      files = [];
      for (const rel of named) {
        const dirRel = path.posix.dirname(rel);
        const found = r.snapshot
          ? [resolveStoragePath(rel)].filter((f) => existsSync(f))
          : revisionFiles(path.dirname(resolveStoragePath(rel)), r.nodeId, 'tables');
        for (const f of found) {
          if (seen.has(f)) continue;
          seen.add(f);
          if (f !== abs && !named.some((n) => resolveStoragePath(n) === f) && leaveOut(f)) continue;
          files.push({ abs: f, rel: `${dirRel}/${path.basename(f)}` });
        }
      }
    } catch (err) {
      report.failed.push({
        nodeId: r.nodeId,
        error: errorMessage(err),
      });
      continue;
    }
    if (!existsSync(abs)) report.missing.push({ nodeId: r.nodeId, storagePath });
    for (const file of files) {
      try {
        // The live layout (the folder the stored path names), so a restore
        // drops each file where the rows point.
        const dest = path.join(destDir, layoutDirOf(file.rel, r.ownerId), path.basename(file.abs));
        // In a SQL child, off the event loop (apps audit 2026-10-02, item 14).
        await copySqliteFile(file.abs, dest);
        report.snapshotted.push({
          ownerId: r.ownerId,
          nodeId: r.nodeId,
          bytes: statSync(dest).size,
          draft: /\.draft\.sqlite$/.test(file.abs),
        });
      } catch (err) {
        report.failed.push({
          nodeId: r.nodeId,
          error: errorMessage(err),
        });
      }
    }
  }
  return report;
}

/** The directory a stored path names (its first segment, `<owner>` of
 *  `<owner>/<node>.sqlite`), else `fallback`: a backup mirrors the live
 *  layout, never re-derives it from the row's owner. */
export function layoutDirOf(storagePath: string, fallback: string): string {
  const dir = path.dirname(storagePath);
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(dir) && dir !== '..' ? dir : fallback;
}
