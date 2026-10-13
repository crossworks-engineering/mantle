/**
 * Tables · create, metadata update, and delete.
 *
 * `updateTable` is METADATA ONLY (title / tags / icon / visibility): it never
 * touches the grid or the index, because grid edits go through the draft and
 * commit path instead. That separation is why an app-bound table can still be
 * renamed while its cells stay owned by the export sync.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  db,
  headsOrSpace,
  nodes,
  tables,
  withDeadlockRetry,
  withNodeDeleteHeads,
  withNodeInsertHeads,
} from '@mantle/db';
import {
  MATERIALIZE_MAX,
  TableTooLargeError,
  importMaxRows,
  publishedPath,
  relativeStoragePath,
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
import { buildTableDataText, registryFileColumns, SNAPSHOT_OWNER } from '../table-storage';
import { withTableCreate, withTableDelete } from '../table-broker';
import {
  TABLES_ROOT_LABEL,
  TAB_NAME,
  assertTableNotAppBound,
  dedupeTags,
  detailOf,
  docsOf,
  ensureRoot,
  tabsFromStats,
} from './shared';

/** The transaction a heads wrapper hands its work. */
type HeadsTx = Parameters<Parameters<typeof headsOrSpace>[1]>[0];

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
   *  (app-table-exports.ts, client tier audit I2). */
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

  // Sqlite-first (signed off 2026-07-15): the workbook file is written inside
  // the transaction, BEFORE the registry row that references it becomes
  // visible — a registry row pointing at a missing file can never be
  // committed. A failure inside it removes the file below. Inside a personal
  // space this transaction is only a savepoint: the space transaction can
  // still roll back after it, so the file is removed then too
  // (afterRollback). JSONB `data`/`data_text` are dual-written through the
  // transition (rollback = clear storage_path, plan §9).
  const publishedAbs = publishedPath(ownerId, id);
  // Heads first (workspaces plan U1): the folder the table lands in. No
  // retry: the transaction writes the workbook file. The store broker (A3b):
  // the node's INSERT is the check, then the file, then the registry row; a
  // failure (or, inside a personal space, the space's rollback) removes the
  // file again.
  return withTableCreate<ReturnType<typeof detailOf>, HeadsTx>(
    ownerId,
    id,
    (run) =>
      headsOrSpace<ReturnType<typeof detailOf>>(
        (f) => withNodeInsertHeads(ownerId, [{ type: 'table', path: TABLES_ROOT_LABEL }], f),
        run,
      ),
    // @heads-held: runs inside the open above (headsOrSpace, withNodeInsertHeads).
    async (tx, t, checkInsert) => {
      const node = checkInsert(
        (
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
                ...(input.description?.trim() ? { description: input.description.trim() } : {}),
                ...(input.brainDepth ? { brain_depth: input.brainDepth } : {}),
              },
              tags: dedupeTags(input.tags ?? []),
            })
            .returning()
        )[0],
      );
      const res = await t.writeDoc(publishedAbs, workbook ?? data, {
        nodeId: id,
        ownerId,
        tabName: TAB_NAME,
        fts: true,
      });
      await tx.insert(tables).values({
        nodeId: node.id,
        // JSONB mirror only while it fits the window AND stays single-tab;
        // beyond either, the file is the sole carrier (a multi-hundred-MB
        // blob mirrors nothing useful, and the mirror can't represent tabs).
        data: !workbook && data.rows.length <= MATERIALIZE_MAX ? data : {},
        dataText: buildTableDataText(publishedAbs, workbook ? null : data, node.title),
        ...registryFileColumns(res, relativeStoragePath(ownerId, id)),
      });
      return detailOf(node, data, null, {
        totalRows,
        tabs: tabsFromStats(res.stats),
        tabId: res.stats.tabs[0]?.tabId,
      });
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

  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const newData: Record<string, unknown> = { ...oldData };
  if (input.icon !== undefined) newData.icon = input.icon;
  if (input.visibility !== undefined) newData.visibility = input.visibility;

  const [row] = await db
    .update(nodes)
    .set({
      ...(input.title !== undefined
        ? { title: input.title.trim().slice(0, 200) || 'Untitled table' }
        : {}),
      ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
      data: newData,
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();
  if (!row) return null;

  const [p] = await db
    .select({ data: tables.data, draft: tables.draftData, storagePath: tables.storagePath })
    .from(tables)
    .where(eq(tables.nodeId, id))
    .limit(1);
  const { data, draft } = docsOf(p ?? { storagePath: null, data: null, draft: null });
  return detailOf(row, data, draft);
}

export async function deleteTable(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id, storagePath: tables.storagePath })
    .from(nodes)
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return false;
  // An app table can't be deleted out from under its export link — remove the
  // export first (or delete the app; the link cascades either way). A
  // read-only snapshot copy may be deleted (W6b fix round 2, M-1): only the
  // app-bound check, never the copy check of assertTableWritable.
  await assertTableNotAppBound(id);
  // `tables` row cascades. The store broker (A3b): the delete of exactly
  // one node is the check; the workbook files are moved aside inside it and
  // dropped once it commits (inside a personal space, once the space
  // commits), or put back if it does not: a failed delete never leaves a
  // registry row pointing at removed files. A member author's copy of the
  // accepted version (audit F07) goes too: its row went with the node.
  await withTableDelete<HeadsTx>(
    ownerId,
    id,
    row.storagePath,
    row.storagePath ? [publishedPath(SNAPSHOT_OWNER, id)] : [],
    (run) => headsOrSpace((f) => withDeadlockRetry(() => withNodeDeleteHeads([id], f)), run),
    // @heads-held: runs inside the open above (headsOrSpace, withNodeDeleteHeads).
    (tx) => tx.delete(nodes).where(eq(nodes.id, id)).returning({ id: nodes.id }),
  );
  return true;
}
