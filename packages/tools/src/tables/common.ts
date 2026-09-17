/**
 * Shared table helpers: preconditions, column and cell resolution,
 * tab loading, paging metadata, and the draft-ops editor.
 *
 * Split out of builtins-tables.ts; bodies moved verbatim.
 */

import {
  ensureTableDoc,
  findColumn,
  findColumnByName,
  findRow,
  getTable,
  applyTableOps,
  type CellValue,
  type Column,
  type ColumnType,
  type TableDoc,
  type TableDetail,
} from '@mantle/content';
import { existsSync } from 'node:fs';
import { tableSqlSurface } from '@mantle/content/table-storage';
import { draftPathFor, readRowById, type TableOp } from '@mantle/tabledb';
import type { ToolHandlerResult } from '../types';
import { str } from '../coerce';
import { notFound } from '../errors';
import type { ToolPrecondition } from '../types';
import { errorMessage } from '@mantle/std';

// Shared referential preconditions (checked centrally in dispatch — see
// preconditions.ts): the id must name an EXISTING node of the right type.
export const TABLE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'table_id', nodeType: 'table', lookup: 'table_list' },
];

export const TABLE_NODE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'id', nodeType: 'table', lookup: 'table_list' },
];

export const FILE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'file_id', nodeType: 'file', lookup: 'file_list / search_nodes' },
];

/** The doc an edit operates on: the in-flight draft if present, else published. */
function baseline(table: TableDetail): TableDoc {
  return ensureTableDoc(table.draft ?? table.data);
}

/** Resolve a column reference (id OR name) to its Column. */
export function resolveColumn(doc: TableDoc, ref: string): Column | null {
  return findColumn(doc, ref) ?? findColumnByName(doc, ref);
}

/** Column summary for tool outputs. A linked (reference) column also reports
 *  its `linked_to` source ids so the assistant knows where the values come
 *  from (v2.2). */
export function colSummary(c: Column): {
  id: string;
  name: string;
  type: ColumnType;
  formula?: string;
  linked_to?: { tab_id: string; column_id: string };
} {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    ...(c.formula ? { formula: c.formula } : {}),
    ...(c.type === 'reference' && c.ref
      ? { linked_to: { tab_id: c.ref.tabId, column_id: c.ref.columnId } }
      : {}),
  };
}

/** Map a cells object keyed by column name-or-id to one keyed by column id.
 *  Unknown columns are dropped and reported back to the caller. */
export function resolveCells(
  doc: TableDoc,
  input: Record<string, unknown>,
): { cells: Record<string, CellValue>; unknown: string[] } {
  const cells: Record<string, CellValue> = {};
  const unknownRefs: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const col = resolveColumn(doc, k);
    if (col) cells[col.id] = v as CellValue;
    else unknownRefs.push(k);
  }
  return { cells, unknown: unknownRefs };
}

/** Make a clipped page self-announce. Every windowed read caps `rows` at 500;
 *  the exact unbounded count lives in `total`. When more rows match than were
 *  returned, surface `truncated`/`next_offset`/`hint` so a caller never mistakes
 *  the returned slice for the whole result set (and knows to page or to read
 *  the total for counts). Returns {} when nothing was clipped. */
export function pageMeta(total: number, offset: number, returned: number): Record<string, unknown> {
  const more = total - (offset + returned);
  if (more <= 0) return {};
  const nextOffset = offset + returned;
  return {
    truncated: true,
    next_offset: nextOffset,
    hint:
      `${more} more row(s) match beyond this page — only ${returned} of ${total} returned. ` +
      `For a COUNT use the total (${total}); to read the rest, re-call with offset=${nextOffset}.`,
  };
}

export const DRAFT_REVIEW_HINT = (tableId: string) =>
  `Edit applied to DRAFT — the published table is unchanged. Tell the user to ` +
  `open /tables/${tableId} to review; the editor shows the draft. Commit ` +
  `publishes (and re-indexes), Discard reverts.`;

/** Draft-first workbook file for windowed reads/writes; null = legacy JSONB
 *  table (still served by the doc path). */
export async function windowFile(ownerId: string, tableId: string): Promise<string | null> {
  const surface = await tableSqlSurface(ownerId, tableId).catch(() => null);
  if (!surface) return null;
  const draftAbs = draftPathFor(surface.abs);
  return existsSync(draftAbs) ? draftAbs : surface.abs;
}

/** Row-existence check that works past the materialize window: the clipped
 *  doc first (free), then the workbook file by id. Legacy tables only have
 *  the doc. */
export async function rowExists(
  ownerId: string,
  tableId: string,
  doc: TableDoc,
  rowId: string,
  tabId?: string,
): Promise<boolean> {
  if (findRow(doc, rowId)) return true;
  const file = await windowFile(ownerId, tableId);
  if (!file) return false;
  return readRowById(file, rowId, tabId ? { tabId } : {}) !== null;
}

export const TAB_HINT =
  "Tab to target, by name or id — from `table_get`'s tabs. Omit for the first tab.";

/** Load a table plus the TARGET TAB's baseline doc. `tabRef` is a tab id or
 *  name (case-insensitive); absent = first tab (single-tab tables never need
 *  it). Returns `tabId` only when explicitly targeted — ops then carry it. */
export async function loadTab(
  ownerId: string,
  tableId: string,
  tabRef: unknown,
): Promise<{ table: TableDetail; doc: TableDoc; tabId?: string } | { error: string }> {
  const table = await getTable(ownerId, tableId);
  if (!table) return { error: `table ${tableId} not found — check the id with table_list` };
  const want = str(tabRef).trim();
  if (!want) return { table, doc: baseline(table) };
  const tabs = table.tabs ?? [];
  const hit =
    tabs.find((t) => t.id === want) ??
    tabs.find((t) => t.name.toLowerCase() === want.toLowerCase());
  if (!hit) {
    return {
      error: `no tab '${want}' on this table — tabs: ${tabs.map((t) => t.name).join(', ') || '(single tab)'}`,
    };
  }
  if (hit.id === table.tabId) return { table, doc: baseline(table), tabId: hit.id };
  const scoped = await getTable(ownerId, tableId, { tabId: hit.id });
  if (!scoped) return { error: `table ${tableId} not found (race?)` };
  return { table: scoped, doc: baseline(scoped), tabId: hit.id };
}

/** Resolve a `reference: {tab, column}` input (names or ids) to the engine's
 *  {tabId, columnId}. Same-workbook only. */
export async function resolveRefTarget(
  ownerId: string,
  tableId: string,
  refInput: unknown,
): Promise<{ ref: { tabId: string; columnId: string } } | { error: string }> {
  const rec = (refInput ?? {}) as Record<string, unknown>;
  const tabRef = str(rec.tab).trim();
  const colRef = str(rec.column).trim();
  if (!tabRef || !colRef) {
    return {
      error:
        "a reference column needs `reference: { tab, column }` — the source tab and column it offers values from (see table_get's tabs)",
    };
  }
  const loaded = await loadTab(ownerId, tableId, tabRef);
  if ('error' in loaded) return { error: loaded.error };
  const srcTabId = loaded.tabId ?? loaded.table.tabId;
  if (!srcTabId)
    return {
      error: `cannot resolve tab '${tabRef}' — this table has no tab metadata (commit it once, then retry)`,
    };
  const col = resolveColumn(loaded.doc, colRef);
  if (!col) return { error: `column '${colRef}' not found on tab '${tabRef}'` };
  if (col.type === 'formula') return { error: 'a reference column cannot target a formula column' };
  return { ref: { tabId: srcTabId, columnId: col.id } };
}

/** Validate against the target tab's baseline doc, then dispatch draft OPS —
 *  the structural (column/view/aggregate) tools' shape since v2.1: the op
 *  path targets any tab and scales past the materialize window (the old
 *  whole-doc save refused clipped tables and would have dropped sibling
 *  tabs). */
export async function editViaOps(
  ownerId: string,
  tableId: string,
  tabRef: unknown,
  build: (doc: TableDoc) => { ops: TableOp[]; output?: Record<string, unknown>; error?: string },
): Promise<ToolHandlerResult> {
  const loaded = await loadTab(ownerId, tableId, tabRef);
  if ('error' in loaded) return { ok: false, error: loaded.error };
  const res = build(loaded.doc);
  if (res.error) return { ok: false, error: res.error };
  const targetTabId = loaded.tabId;
  try {
    const applied = await applyTableOps(
      ownerId,
      tableId,
      targetTabId ? res.ops.map((o) => ({ ...o, tabId: targetTabId })) : res.ops,
    );
    if (!applied) return notFound('table', tableId, 'table_list');
    if (!applied.ok) return { ok: false, error: 'draft changed concurrently — retry' };
    return {
      ok: true,
      output: {
        table_id: tableId,
        ...(loaded.tabId ? { tab_id: loaded.tabId } : {}),
        ...res.output,
        draft_saved: true,
        hint: DRAFT_REVIEW_HINT(tableId),
      },
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ───────────────────────── CRUD / metadata ─────────────────────────

export const CELLS_HINT =
  'cells keyed by column NAME or id, e.g. { "Qty": 3, "Status": "Open" }. Values are coerced to the column type.';
