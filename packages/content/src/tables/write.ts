/**
 * Tables · create, metadata update, and delete.
 *
 * `updateTable` is METADATA ONLY (title / tags / icon / visibility): it never
 * touches the grid or the index, because grid edits go through the draft and
 * commit path instead. That separation is why an app-bound table can still be
 * renamed while its cells stay owned by the export sync.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  afterCommit,
  afterOuterRollback,
  changedFields,
  markContentChanged,
  db,
  headsOrSpace,
  inFlipTransaction,
  oneRow,
  removeSqliteFile,
  revisionFiles,
  nodes,
  tables,
  withDeadlockRetry,
  withNodeDeleteHeads,
  withNodeInsertHeads,
} from '@mantle/db';
import path from 'node:path';
import {
  MATERIALIZE_MAX,
  TableTooLargeError,
  importMaxRows,
  resolveStoragePath,
} from '@mantle/tabledb';
import {
  ensureTableDoc,
  ensureWorkbookDoc,
  emptyTableDoc,
  type TableDoc,
  type WorkbookDoc,
  type TableDetail,
  type TableVisibility,
} from '@mantle/content-core/table-model';
import { buildTableDataText, registryFileColumns } from '../table-storage';
import { snapshotTableAbs } from '../member-snapshots';
import { stageDoc, stageThenFlipTable, tableRevisionPath } from '../table-broker';
import {
  TABLES_ROOT_LABEL,
  TAB_NAME,
  assertTableNotAppBound,
  detailOf,
  docsOf,
  ensureRoot,
  tabsFromStats,
} from './shared';
import { dedupeTags } from '../tags';

export type CreateTableInput = {
  title: string;
  data?: TableDoc;
  /** Multi-tab creation (import: one workbook per spreadsheet, sheet→tab).
   *  Mutually exclusive with `data`; wins when both are set. */
  tabs?: WorkbookDoc['tabs'];
  tags?: string[];
  icon?: string;
  /** Provenance: the `file` node this grid was imported from. Stamped on the
   *  table node's `data.sourceFileId` so an auto-importer can dedupe (don't
   *  re-create a table for a file that already has one) and the UI can link back
   *  to the source. Ignored by the table renderer (the grid lives in
   *  `tables.data`). */
  sourceFileId?: string;
  /** The sha256 of the source file's bytes the grid was built from, stamped
   *  on `data.sourceSha256`: a drawing's table names the revision its
   *  geometry came from, so a file replaced in place later (same node, new
   *  bytes) is seen as newer than its table (the image check, circuit_verify). */
  sourceSha256?: string;
  /**
   * A caveat or usage note the reader must see BEFORE they query.
   *
   * Column names describe shape, not semantics, and some grids are wrong when
   * read the obvious way. A Microsoft Project import is the case that prompted
   * this: its summary rows already contain their children, so `SUM(work)` over
   * every row overstates by once per outline level — on a five-level plan, ~5x.
   * Nothing in the column list says so, and the wrong answer looks entirely
   * plausible.
   *
   * Surfaced by `schemaToText`, which is what an agent reads before writing
   * SQL. Stored on the node's `data` rather than its summary so the extractor's
   * generated summary can't overwrite it.
   */
  description?: string;
  /** Index at retrieval depth only (`data.brain_depth`: no entities,
   *  relations or facts). A Table exported from an app clients write
   *  (app-table-exports.ts). */
  brainDepth?: 'retrieval';
};

export async function createTable(ownerId: string, input: CreateTableInput): Promise<TableDetail> {
  await ensureRoot(ownerId);
  const workbook = input.tabs?.length ? ensureWorkbookDoc({ tabs: input.tabs }) : null;
  const data = workbook
    ? ensureTableDoc(workbook.tabs[0])
    : ensureTableDoc(input.data ?? emptyTableDoc());
  const totalRows = workbook
    ? workbook.tabs.reduce((a, t) => a + t.rows.length, 0)
    : data.rows.length;
  // Imports are the one whole-doc entry point allowed past the materialize
  // window (part-splitting is dead) — bounded by the explicit-error ceiling
  // (signed off: error with guidance, never auto-raise or silent partial).
  if (totalRows > importMaxRows()) {
    throw new TableTooLargeError(totalRows, importMaxRows(), 'import');
  }
  const id = randomUUID();

  // Sqlite-first: the workbook file is written inside
  // the transaction, BEFORE the registry row that references it becomes
  // visible — a registry row pointing at a missing file can never be
  // committed. A failure inside it removes the file below. Inside a personal
  // space this transaction is only a savepoint: the space transaction can
  // still roll back after it, so the file is removed then too
  // (afterOuterRollback). JSONB `data`/`data_text` are dual-written through the
  // transition (rollback = clear storage_path).
  // The store broker: the workbook is staged under a new
  // revision name no row points at, then the create's transaction inserts
  // the node (the check: exactly one row) and the registry row pointing at
  // it. A failure removes the stage; inside a personal space the space's
  // rollback does (afterOuterRollback).
  const pubRel = tableRevisionPath(ownerId, id, false);
  return stageThenFlipTable(
    () => {
      const st = stageDoc(pubRel, workbook ?? data, {
        nodeId: id,
        ownerId,
        tabName: TAB_NAME,
        fts: true,
      });
      return { ...st, files: [st.abs] };
    },
    async (staged) => {
      // Heads first: the folder the table lands in.
      const created = await headsOrSpace<ReturnType<typeof detailOf>>(
        (f) => withNodeInsertHeads(ownerId, [{ type: 'table', path: TABLES_ROOT_LABEL }], f),
        (tx) =>
          inFlipTransaction(async () => {
            const node = oneRow(
              'tables',
              await tx
                .insert(nodes)
                .values({
                  id,
                  ownerId,
                  type: 'table',
                  title: input.title.trim().slice(0, 200) || 'Untitled table',
                  path: TABLES_ROOT_LABEL,
                  data: {
                    visibility: 'private',
                    ...(input.icon ? { icon: input.icon } : {}),
                    ...(input.sourceFileId ? { sourceFileId: input.sourceFileId } : {}),
                    ...(input.sourceSha256 ? { sourceSha256: input.sourceSha256 } : {}),
                    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
                    ...(input.brainDepth ? { brain_depth: input.brainDepth } : {}),
                  },
                  tags: dedupeTags(input.tags ?? []),
                })
                .returning(),
              'table',
            );
            await tx.insert(tables).values({
              nodeId: node.id,
              // JSONB mirror only while it fits the window AND stays
              // single-tab; beyond either, the file is the sole carrier.
              data: !workbook && data.rows.length <= MATERIALIZE_MAX ? data : {},
              dataText: buildTableDataText(staged.abs, workbook ? null : data, node.title),
              ...registryFileColumns(staged.res, pubRel),
            });
            return detailOf(node, data, null, {
              totalRows,
              tabs: tabsFromStats(staged.res.stats),
              tabId: staged.res.stats.tabs[0]?.tabId,
            });
          }),
      );
      // An outer transaction this create joined (a personal space, a
      // login's open write transaction) may still roll back: the stage goes
      // with it, never a file no row will name.
      afterOuterRollback(() => removeSqliteFile(staged.abs));
      return created;
    },
  );
}

export type UpdateTableInput = Partial<{
  title: string;
  tags: string[];
  icon: string;
  visibility: TableVisibility;
}>;

/** Metadata-only update (title / tags / icon / visibility). Never touches the
 *  grid or the index — grid edits go through saveTableDraft + commitTable. */
export async function updateTable(
  ownerId: string,
  id: string,
  input: UpdateTableInput,
): Promise<TableDetail | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!node) return null;

  // Only the keys this update writes, merged into the stored data in the
  // statement itself (jsonb ||): a key another writer set since the read
  // above (circuit_verify's claims under its own lock, say) is kept.
  const patch: Record<string, unknown> = {};
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.visibility !== undefined) patch.visibility = input.visibility;

  const title =
    input.title !== undefined ? input.title.trim().slice(0, 200) || 'Untitled table' : node.title;
  // A new title re-embeds (the kind registry's `indexed`): the extractor
  // reuses the committed summary and rebuilds the vector and the profile
  // passages locally, no model call. The look and the tags feed no index.
  const changed = changedFields({ title: [node.title, title] });
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .update(nodes)
      .set({
        ...(input.title !== undefined ? { title } : {}),
        ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
        ...(Object.keys(patch).length
          ? { data: sql`coalesce(${nodes.data}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, id))
      .returning();
    if (!r) return r;
    return (await markContentChanged(tx, { id, type: 'table' }, changed)) ?? r;
  });
  if (!row) return null;

  const [p] = await db
    .select({
      data: tables.data,
      draft: tables.draftData,
      storagePath: tables.storagePath,
      draftPath: tables.draftPath,
    })
    .from(tables)
    .where(eq(tables.nodeId, id))
    .limit(1);
  const { data, draft } = docsOf(p ?? { storagePath: null, data: null, draft: null });
  return detailOf(row, data, draft);
}

export async function deleteTable(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id, storagePath: tables.storagePath, draftPath: tables.draftPath })
    .from(nodes)
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return false;
  // An app table can't be deleted out from under its export link — remove the
  // export first (or delete the app; the link cascades either way). A
  // read-only snapshot copy may be deleted: only the
  // app-bound check, never the copy check of assertTableWritable.
  await assertTableNotAppBound(id);
  // `tables` row cascades. The store broker: the delete of
  // exactly one node is the check.
  await headsOrSpace(
    (f) => withDeadlockRetry(() => withNodeDeleteHeads([id], f)),
    async (tx) =>
      oneRow(
        'tables',
        await tx.delete(nodes).where(eq(nodes.id, id)).returning({ id: nodes.id }),
        'table',
      ),
  );
  // Workbook files go AFTER the registry delete commits (a failed delete
  // must never leave a registry row pointing at removed files); inside a
  // personal space afterCommit waits for the space transaction. The table's
  // own files, not the sweep's (the sweep never removes a file whose item
  // has no row): every revision of the table in the folders its row named,
  // and a member author's copy of the accepted version, whose row went with
  // the node.
  // Best-effort; the sanity check reports orphaned files.
  const named = [row.storagePath, row.draftPath].filter((p): p is string => !!p);
  if (named.length > 0) {
    await afterCommit(() => {
      const dirs = new Set(named.map((p) => path.dirname(resolveStoragePath(p))));
      for (const d of dirs) revisionFiles(d, id, 'tables').forEach(removeSqliteFile);
      removeSqliteFile(snapshotTableAbs(id));
    });
  }
  return true;
}
