/**
 * circuit_verify, the store: each answer is filed with its evidence next to
 * the drawing it is about. No new database (owner, 2026-10-25): every DWG
 * import already has its own workbook (the auto-import table), and the
 * check adds a Checks tab to it, one row per answer: the key, the
 * question, the answer (and, after a no, the alternative the image named)
 * and its reason, the trust it gives, the model, the
 * date, the drawing's revision and file, the crops' file ids and the seal
 * (./check-seal.ts: only rows circuit_verify wrote are ever applied).
 *
 * The crops are ordinary image files under Auto-filed > Drawing checks,
 * one folder per drawing, each flagged `indexing: 'metadata'`: stored and
 * findable by name, its content never read (no vision pass, no summary;
 * the extractor's metadata path calls no model). They carry the links the
 * drawing's own render carries: `data.sourceFileId` (the DWG file: its
 * derived items, reaped with it) and `data.sourceTableId` (the table whose
 * Checks rows name them). The table write is a commit with `noModelPass`:
 * a summarised table is re-embedded locally, an unsummarised one asks no
 * index work at all. So filing a check never spends.
 *
 * Rights are the caller's, and asked BEFORE anything is spent
 * (`storeRefusal`, called by verify.ts ahead of every vision request): the
 * edit right on the table, a writable table (not app-bound, not a snapshot
 * copy), no draft open, and a crop folder the caller may create in. The
 * write itself asks again (applyTableOps). A draft is never published by
 * accident: the write and the commit are pinned to the draft revision this
 * call made (`ifRev`), and only that draft is discarded when the commit
 * fails, so a user who opens the table meanwhile keeps their work. A user
 * who writes into the draft between the write and the commit keeps it
 * with these rows in it: they publish with the user's commit, and their
 * crops are kept as the evidence (the result says the rows are pending).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { advisoryXactLock, db, nodes, tables, withHeads } from '@mantle/db';
import { applyTableOps, commitTable, discardTableDraft, tableWriteRefusal } from '@mantle/content';
import { tableSqlSurface } from '@mantle/content/table-storage';
import {
  autoFiledFolderPath,
  callerMayEditFolder,
  deleteFileById,
  ensureAutoFiledFolder,
  ensureFilesRootBranch,
  FILES_ROOT_LABEL,
  folderByPath,
  upsertFile,
} from '@mantle/files';
import {
  DWG_CHECKED_VERSION_KEY,
  DWG_REINDEXED_VERSION_KEY,
  dwgTableEdited,
} from '@mantle/files/dwg';
import type { TableOp } from '@mantle/tabledb';
import { errorMessage } from '@mantle/std';
import { ALT_MAX, CHECK_COLUMNS, CHECKS_TAB, TRUST, type CheckColumn } from './check';
import { sealOf } from './check-seal';
import type { CheckAnswer, StoreResult, VerifyClaim, VerifyRun } from './verify';
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

/** The table's version, draft state and revision, and edit marks now. */
export async function tableState(tableId: string) {
  const [r] = await db
    .select({
      version: tables.version,
      draftRev: tables.draftRev,
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
    draftRev: Number(r.draftRev ?? 0),
    hasDraft: r.hasDraft === true,
    reindexedVersion: num(d[DWG_REINDEXED_VERSION_KEY]),
    checkedVersion: num(d[CHECKED_VERSION_KEY]),
  };
}

/** The crop folder of one drawing, made if missing. */
function cropFolder(ownerId: string, sheet: SheetInput) {
  return ensureAutoFiledFolder(ownerId, 'drawing-checks', { document: cropDocument(sheet) });
}

/** The crop folder of one drawing, as storeChecks would make it. */
const cropDocument = (sheet: SheetInput) => ({
  slug: sheet.sourceFileId ?? sheet.tableId,
  title: sheet.title,
});

/**
 * Why this caller could not file answers about `sheet`, or null when it
 * can: asked before any vision request, so a call that could not keep its
 * answers spends nothing. Each reason says what to do instead.
 *
 * Rights only: the drawing's crop folder is never made here (a folder not
 * there yet is judged by the Files root right that creating it needs).
 * storeChecks makes it when it files, so a sheet that is then skipped
 * (its bytes changed, no crop endpoint, a cap reached) leaves no empty
 * folder. `dryRun` does not make the Files root a fresh box lacks either,
 * so a dry run writes nothing at all.
 */
export async function storeRefusal(
  ownerId: string,
  sheet: SheetInput,
  opts: { dryRun?: boolean } = {},
): Promise<string | null> {
  const refused = await tableWriteRefusal(ownerId, sheet.tableId);
  if (refused) {
    return `the answers could not be stored: you may not edit its table (${refused.slice(0, 160)}); ask someone who may edit the drawing's table to run the check, or use dry_run to see the questions`;
  }
  const state = await tableState(sheet.tableId);
  if (!state) return 'its table is gone';
  if (state.hasDraft) {
    return 'its table has an unsaved draft: commit or discard it, then call again';
  }
  // The crops go under Auto-filed, which only a caller that may change the
  // Files root (the owner, an Admin) creates in.
  if (!opts.dryRun) await ensureFilesRootBranch(ownerId);
  if ((await callerMayEditFolder(ownerId, FILES_ROOT_LABEL)) === false) {
    return 'the crops could not be stored: only the owner or an Admin may create files in Auto-filed > Drawing checks; ask one of them to run the check, or use dry_run to see the questions';
  }
  const path = autoFiledFolderPath('drawing-checks', { document: cropDocument(sheet) });
  const folder = (await folderByPath({ ownerId, path })) ? path : null;
  if (folder && (await callerMayEditFolder(ownerId, folder)) === false) {
    return 'the crops could not be stored: you may not create files in its Auto-filed > Drawing checks folder; ask the owner or an Admin to run the check, or use dry_run';
  }
  return null;
}

export async function storeChecks(
  ownerId: string,
  sheet: SheetInput,
  circuit: string,
  answers: CheckAnswer[],
  overview: Buffer | null,
  checkedAt: string,
  /** Who runs the call (the By column, builtins-circuits.ts callerOf: a
   *  kind and a keyed hash, never a raw id; sealed with the row). */
  by = '',
): Promise<StoreResult> {
  const before = await tableState(sheet.tableId);
  if (!before) return { error: 'the table is gone' };
  if (before.hasDraft) {
    return { error: 'the table has an unsaved draft; commit or discard it, then call again' };
  }

  // 1. The crops: name-only image files, one folder per drawing.
  const folder = await cropFolder(ownerId, sheet);
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
  const made: string[] = [];
  /** The crops this call made, removed when its rows are not written: no
   *  evidence file is left naming answers the table does not hold. */
  const unmake = async () => {
    for (const fileId of made)
      await deleteFileById({ ownerId, fileId, deleteDerived: true }).catch(() => null);
  };
  const save = async (
    name: string,
    bytes: Buffer,
    title: string,
    data: Record<string, unknown>,
  ) => {
    const id = (
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
    made.push(id);
    return id;
  };
  const cropIds = new Map<string, string[]>();
  let overviewId: string | null = null;
  try {
    if (overview) {
      overviewId = await save(
        `${fileSafe(circuit)}-${when}-overview.png`,
        overview,
        `Image check ${circuit}: ${sheet.title}, overview`,
        { checkRole: 'overview' },
      );
    }
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
  } catch (err) {
    await unmake();
    return { error: `the crops could not be saved (${errorMessage(err).slice(0, 160)})` };
  }

  // 2. The Checks tab: made on first use, one row per answer.
  const fail = async (error: string) => {
    await unmake();
    return { error };
  };
  const surface = await tableSqlSurface(ownerId, sheet.tableId);
  if (!surface) return fail('the table could not be opened');
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
  const revision = sheet.revision ?? '';
  for (const a of answers) {
    const ids = cropIds.get(a.q.id) ?? [];
    const crops = [...(overviewId ? [`overview ${overviewId}`] : []), ...ids].join(' ');
    // Every listed alternative fits ALT_MAX (check.ts altsOf); capped here
    // too, the cell and its seal alike, so no stored one is ever longer.
    const alt = (a.alt ?? '').slice(0, ALT_MAX);
    const cells: Record<CheckColumn, string | number | null> = {
      Key: a.q.key,
      Kind: a.q.kind,
      Circuit: circuit,
      Node: a.q.node,
      Handles: a.q.handles.join(' '),
      Guess: a.q.guess,
      Question: a.q.question,
      Answer: a.verdict,
      Alternative: alt,
      Reason: a.reason,
      Trust: TRUST[a.verdict],
      Model: a.model,
      'Checked at': checkedAt,
      Revision: revision,
      File: sheet.sourceFileId ?? '',
      Crops: crops,
      Seal: sealOf({
        tableId: sheet.tableId,
        key: a.q.key,
        circuit,
        question: a.q.question,
        answer: a.verdict,
        reason: a.reason,
        model: a.model,
        revision,
        checkedAt,
        crops,
        alt,
        by,
      }),
      By: by,
    };
    ops.push({
      op: 'row_add',
      tabId,
      cells: Object.fromEntries(CHECK_COLUMNS.map((c) => [colId.get(c)!, cells[c]])),
    });
  }
  // Pinned to the draft revision read above: a draft someone opened since
  // is theirs, and these rows never land in it.
  let applied: Awaited<ReturnType<typeof applyTableOps>>;
  try {
    applied = await applyTableOps(ownerId, sheet.tableId, ops, { ifRev: before.draftRev });
  } catch (err) {
    return fail(`the table refused the write (${errorMessage(err).slice(0, 160)})`);
  }
  if (!applied) return fail('the table refused the write');
  if (!applied.ok) {
    return fail(
      'someone opened or changed the table while the checks were being written; nothing was written to it, call again',
    );
  }
  // The commit publishes exactly the draft this write made (ifRev): one
  // someone added to meanwhile is refused, and only this call's own draft
  // is discarded when the commit fails.
  let committed: Awaited<ReturnType<typeof commitTable>> = null;
  let why = 'the commit found no table';
  /** Whether this call's own draft was thrown away (its rows gone): only
   *  then are its crops removed. A draft someone else wrote to meanwhile
   *  is kept with these rows in it (they publish when that draft is
   *  committed, or already did), so the crops stay as their evidence. */
  let discarded = false;
  try {
    committed = await commitTable(ownerId, sheet.tableId, undefined, {
      noModelPass: true,
      ifRev: applied.draftRev,
      note: `image check of circuit ${circuit}`,
    });
  } catch (err) {
    why = `the commit failed (${errorMessage(err).slice(0, 160)})`;
  } finally {
    if (!committed) {
      discarded = await discardTableDraft(ownerId, sheet.tableId, {
        ifRev: applied.draftRev,
      }).catch(() => false);
    }
  }
  if (!committed && discarded) {
    return fail(`${why}; nothing was written to the table, call again`);
  }
  if (!committed) {
    return {
      stored: 0,
      pending: answers.length,
      note: `someone wrote to the table's draft while the checks were being written, so it was not committed here: the ${answers.length === 1 ? 'row waits' : `${answers.length} rows wait`} in that draft and ${answers.length === 1 ? 'publishes' : 'publish'} when it is committed (or already did); the crops are kept`,
    };
  }

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

/** Node data key: the circuit_verify calls claimed on a drawing's table in
 *  the last hour (verify.ts VerifyDeps.claim). Bookkeeping of the server,
 *  no table op writes it. */
export const VERIFY_RUNS_KEY = 'dwgVerifyRuns';
/** Most claims one table keeps (an hour's worth is far fewer). */
const RUNS_KEPT = 40;
const HOUR = 60 * 60_000;

/** The claims a node's data holds, read loosely. */
function runsOf(tableId: string, v: unknown): VerifyRun[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((r: unknown) => {
    if (!r || typeof r !== 'object') return [];
    const { circuit, by, at, revision } = r as Record<string, unknown>;
    return typeof circuit === 'string' && typeof at === 'string'
      ? [
          {
            tableId,
            circuit,
            at,
            by: typeof by === 'string' ? by : '',
            revision: typeof revision === 'string' ? revision : '',
          },
        ]
      : [];
  });
}

/**
 * circuit_verify's claim (verify.ts VerifyDeps.claim): in one transaction,
 * the heads of the tables it asks about locked and then a lock on the
 * owner's circuit (so two calls on one circuit take turns, whatever sheets
 * each asks about), the claims on every sheet of the circuit go to
 * `refusal`; when it says nothing, this call is recorded on each table it
 * asks about (claims older than an hour dropped) and null comes back.
 */
export async function claimVerifyRun(
  ownerId: string,
  claim: VerifyClaim,
  refusal: (runs: readonly VerifyRun[]) => string | null,
): Promise<string | null> {
  const write = [...new Set(claim.sheets.map((s) => s.tableId))];
  const read = [...new Set([...claim.readFrom, ...write])];
  return withHeads(write, 'update', async (tx) => {
    await advisoryXactLock(tx, `circuit-verify:${ownerId}:${claim.circuit}`, 'hashtextextended');
    const rows = await tx
      .select({ id: nodes.id, runs: sql<unknown>`${nodes.data}->${VERIFY_RUNS_KEY}` })
      .from(nodes)
      .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, read)));
    const runs = rows.flatMap((r) => runsOf(r.id, r.runs));
    const why = refusal(runs);
    if (why) return why;
    const since = Date.parse(claim.at) - HOUR;
    for (const s of claim.sheets) {
      const kept = runs
        .filter((r) => r.tableId === s.tableId && Date.parse(r.at) >= since)
        .map(({ tableId: _t, ...r }) => r);
      const next = [
        ...kept,
        { circuit: claim.circuit, by: claim.by, at: claim.at, revision: s.revision },
      ].slice(-RUNS_KEPT);
      await tx
        .update(nodes)
        .set({
          data: sql`coalesce(${nodes.data}, '{}'::jsonb) || ${JSON.stringify({
            [VERIFY_RUNS_KEY]: next,
          })}::jsonb`,
        })
        .where(and(eq(nodes.ownerId, ownerId), eq(nodes.id, s.tableId)));
    }
    return null;
  });
}
