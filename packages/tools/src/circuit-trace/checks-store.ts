/**
 * circuit_verify, the store: each answer is filed with its evidence next to
 * the drawing it is about. No new database (owner, 2026-10-25): every DWG
 * import already has its own workbook (the auto-import table), and the
 * check adds a Checks tab to it, one row per answer: the key, the
 * question, the answer and its reason, the trust it gives, the model, the
 * date, the drawing's revision and file, and the crops' file ids.
 *
 * The crops are ordinary image files under Auto-filed > Drawing checks,
 * one folder per drawing, each flagged `indexing: 'metadata'`: stored and
 * findable by name, its content never read (no vision pass, no summary;
 * the extractor's metadata path calls no model). The table write is a
 * commit with `keepSummary`: the table is re-embedded locally, no model
 * pass. So filing a check spends nothing.
 *
 * Rights are the caller's: the crops go where it may create files, the
 * Checks tab is an edit of the table (applyTableOps asks). A table with a
 * draft open is never written: the commit would publish someone's working
 * copy. Either refusal is returned as an error, said in the result.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, nodes, tables, withHeads } from '@mantle/db';
import { applyTableOps, commitTable, discardTableDraft } from '@mantle/content';
import { tableSqlSurface } from '@mantle/content/table-storage';
import { ensureAutoFiledFolder, upsertFile } from '@mantle/files';
import {
  DWG_CHECKED_VERSION_KEY,
  DWG_REINDEXED_VERSION_KEY,
  dwgTableEdited,
} from '@mantle/files/dwg';
import type { TableOp } from '@mantle/tabledb';
import { CHECK_COLUMNS, CHECKS_TAB, TRUST, type CheckColumn } from './check';
import type { CheckAnswer } from './verify';
import type { SheetInput } from './walk';

/** Node data key: the table version a check commit made on an unedited
 *  table (dwg-reindex reads it: that commit is not an edit). */
export const CHECKED_VERSION_KEY = DWG_CHECKED_VERSION_KEY;

const COLUMN_TYPE: Partial<Record<CheckColumn, 'number'>> = { Node: 'number' };

const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\..*$/, '');
const fileSafe = (s: string) =>
  s
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'circuit';

/** The table's version, draft state and edit marks now. */
async function tableState(tableId: string) {
  const [r] = await db
    .select({
      version: tables.version,
      hasDraft: sql<boolean>`(${tables.draftPath} is not null or ${tables.draftData} is not null)`,
      data: nodes.data,
    })
    .from(tables)
    .innerJoin(nodes, eq(nodes.id, tables.nodeId))
    .where(eq(tables.nodeId, tableId))
    .limit(1);
  if (!r) return null;
  const d = (r.data ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    version: Number(r.version),
    hasDraft: r.hasDraft === true,
    reindexedVersion: num(d[DWG_REINDEXED_VERSION_KEY]),
    checkedVersion: num(d[CHECKED_VERSION_KEY]),
  };
}

export async function storeChecks(
  ownerId: string,
  sheet: SheetInput,
  circuit: string,
  answers: CheckAnswer[],
  overview: Buffer | null,
  checkedAt: string,
): Promise<{ stored: number } | { error: string }> {
  const before = await tableState(sheet.tableId);
  if (!before) return { error: 'the table is gone' };
  if (before.hasDraft) {
    return { error: 'the table has an unsaved draft; commit or discard it, then call again' };
  }

  // 1. The crops: name-only image files, one folder per drawing.
  const folder = await ensureAutoFiledFolder(ownerId, 'drawing-checks', {
    document: { slug: sheet.sourceFileId ?? sheet.tableId, title: sheet.title },
  });
  const when = stamp(checkedAt);
  const base = {
    indexing: 'metadata',
    provenance: 'drawing-check',
    sourceFileId: sheet.sourceFileId,
    sourceTableId: sheet.tableId,
    revision: sheet.revision ?? null,
    circuit,
    checkedAt,
  };
  const save = async (name: string, bytes: Buffer, title: string, data: Record<string, unknown>) =>
    (
      await upsertFile({
        ownerId,
        parentPath: folder,
        filename: name,
        bytes,
        overwrite: false,
        title,
        tags: ['drawing-check'],
        data: { ...base, ...data },
      })
    ).id;
  let overviewId: string | null = null;
  if (overview) {
    overviewId = await save(
      `${fileSafe(circuit)}-${when}-overview.png`,
      overview,
      `Image check ${circuit}: ${sheet.title}, overview`,
      { checkRole: 'overview' },
    );
  }
  const cropIds = new Map<string, string[]>();
  for (const a of answers) {
    const ids: string[] = [];
    for (const c of a.crops) {
      ids.push(
        await save(
          `${fileSafe(circuit)}-${when}-${a.q.id}-${c.part + 1}.png`,
          c.png,
          `Image check ${circuit}: ${sheet.title}, ${a.q.id} (${a.q.kind}) crop ${c.part + 1} of ${c.of}`,
          { checkKey: a.q.key, checkKind: a.q.kind, window: c.window, textPx: c.textPx },
        ),
      );
    }
    cropIds.set(a.q.id, ids);
  }

  // 2. The Checks tab: made on first use, one row per answer.
  const surface = await tableSqlSurface(ownerId, sheet.tableId);
  if (!surface) return { error: 'the table could not be opened' };
  const ops: TableOp[] = [];
  const existing = surface.tabs.find((t) => t.name === CHECKS_TAB);
  let tabId: string;
  const colId = new Map<string, string>();
  if (existing) {
    tabId = existing.tabId;
    for (const c of existing.columns) colId.set(c.name, c.colId);
  } else {
    tabId = randomUUID();
    ops.push({ op: 'tab_add', tabId, name: CHECKS_TAB });
  }
  for (const name of CHECK_COLUMNS) {
    if (colId.has(name)) continue;
    const id = randomUUID();
    colId.set(name, id);
    ops.push({
      op: 'column_add',
      tabId,
      column: { id, name, type: COLUMN_TYPE[name] ?? 'text' },
    });
  }
  for (const a of answers) {
    const ids = cropIds.get(a.q.id) ?? [];
    const cells: Record<CheckColumn, string | number | null> = {
      Key: a.q.key,
      Kind: a.q.kind,
      Circuit: circuit,
      Node: a.q.node,
      Handles: a.q.handles.join(' '),
      Guess: a.q.guess,
      Question: a.q.question,
      Answer: a.verdict,
      Reason: a.reason,
      Trust: TRUST[a.verdict],
      Model: a.model,
      'Checked at': checkedAt,
      Revision: sheet.revision ?? '',
      File: sheet.sourceFileId ?? '',
      Crops: [...(overviewId ? [`overview ${overviewId}`] : []), ...ids].join(' '),
    };
    ops.push({
      op: 'row_add',
      tabId,
      cells: Object.fromEntries(CHECK_COLUMNS.map((c) => [colId.get(c)!, cells[c]])),
    });
  }
  const applied = await applyTableOps(ownerId, sheet.tableId, ops);
  if (!applied) return { error: 'the table refused the write' };
  if ('conflict' in applied && applied.conflict) {
    return { error: 'the table changed while the checks were written; call again' };
  }
  // A commit that fails leaves no half-written draft behind (the table had
  // none before this write: checked above).
  let committed: Awaited<ReturnType<typeof commitTable>> = null;
  try {
    committed = await commitTable(ownerId, sheet.tableId, undefined, {
      keepSummary: true,
      note: `image check of circuit ${circuit}`,
    });
  } finally {
    if (!committed) await discardTableDraft(ownerId, sheet.tableId).catch(() => false);
  }
  if (!committed) return { error: 'the commit found no table' };

  // 3. Not an edit for dwg-reindex, when the table was unedited before.
  if (!dwgTableEdited(before)) {
    const after = await tableState(sheet.tableId);
    if (after && after.version === before.version + 1) {
      await withHeads([sheet.tableId], 'update', (tx) =>
        tx
          .update(nodes)
          .set({
            data: sql`coalesce(${nodes.data}, '{}'::jsonb) || ${JSON.stringify({
              [CHECKED_VERSION_KEY]: after.version,
            })}::jsonb`,
          })
          .where(eq(nodes.id, sheet.tableId)),
      );
    }
  }
  return { stored: answers.length };
}
