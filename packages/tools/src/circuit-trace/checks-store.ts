/**
 * circuit_verify, the store: each answer is filed on the drawing's file row
 * (data.drawingChecks), sealed under the file's id (./check-seal.ts: only what
 * circuit_verify wrote is ever applied), whichever data source the file reads.
 * So an answer filed while the file reads its old Table still applies once its
 * database is built, and it goes with the file. A rebuild of a database cannot
 * lose it. The old Checks tab is not read or written.
 *
 * Each answer holds the key, the question, the answer (and, after a no, the
 * alternative the image named) and its reason, the trust it gives, the model,
 * the date, the drawing's revision and file, the crops' file ids and the seal.
 * Newest per circuit, guess and revision, and at most ANSWERS_CAP_BYTES a file:
 * the oldest revision's answers go first. A revision near the cap is refused
 * before any spend (storeRefusal), so answers cannot rotate and be paid for
 * again.
 *
 * The crops are ordinary image files under Auto-filed > Drawing checks,
 * one folder per drawing, each flagged `indexing: 'metadata'`: stored and
 * findable by name, its content never read (no vision pass, no summary;
 * the extractor's metadata path calls no model). They carry the link the
 * drawing's own render carries: `data.sourceFileId` (the DWG file: its
 * derived items, reaped with it).
 *
 * Rights are the caller's, and asked BEFORE anything is spent (`storeRefusal`,
 * called by verify.ts ahead of every vision request): the shared refusal of a
 * file's rows, edit of the file, and a crop folder the caller may create in.
 * Both row writes keep `updated_at`, as a bumped date voids a terminal skip and a
 * drain could queue the file again. They change the row under the heads, inside
 * the transaction, as two circuits can share a drawing and the lock on a verify
 * run is per circuit. No write during an extract: the extract's write is guarded
 * on the row's version, so it would fail and the retry would pay again.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  advisoryXactLock,
  assertItemRight,
  db,
  isSnapshotCopy,
  nodes,
  readIndexWork,
  withHeads,
} from '@mantle/db';
import {
  autoFiledFolderPath,
  callerMayEditFolder,
  deleteFileById,
  DRAWING_CHECK_PROVENANCE,
  ensureAutoFiledFolder,
  ensureFilesRootBranch,
  fileDataRefusal,
  fileDataRow,
  FILES_ROOT_LABEL,
  folderByPath,
  resolveEffectiveIndexing,
  upsertFile,
} from '@mantle/files';
import { DWG_ANSWERS_KEY, DWG_VERIFY_RUNS_KEY } from '@mantle/files/dwg';
import { errorMessage } from '@mantle/std';
import {
  ALT_MAX,
  cropCellWords,
  sealFieldsOf,
  storedChecksOf,
  TRUST,
  VERIFY_MAX,
  type StoredCheck,
} from './check';
import { sealOf } from './check-seal';
import { circuitKey } from './check-keys';
import type { CheckAnswer, StoreResult, VerifyClaim, VerifyRun } from './verify';
import type { SheetInput } from './walk';

/** The most answers one file holds, in bytes of JSON. */
export const ANSWERS_CAP_BYTES = 256 * 1024;
/** Room kept for one call: it adds up to VERIFY_MAX.questions answers, about
 *  1 KB each, and a long path's crops can double one. */
export const ANSWERS_CALL_MARGIN_BYTES = VERIFY_MAX.questions * 2048;

const bytesOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\..*$/, '');
const fileSafe = (s: string) =>
  s
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'circuit';

/** The words for a file row turned private since the read. */
const TURNED_PRIVATE =
  'its file was set to stay out of the brain during the check, so nothing was filed; set its indexing to full, then call again';

/** Whether a file row, as this transaction reads it, is effectively private. It
 *  reads the row's own flag and the chain this scope reads. A folder only other
 *  workspaces read was asked just before the transaction (fileDataRefusal). */
async function turnedPrivate(ownerId: string, row: Pick<SheetRow, 'path' | 'indexing'>) {
  const { effective } = await resolveEffectiveIndexing(ownerId, {
    path: row.path,
    data: row.indexing ? { indexing: row.indexing } : {},
  });
  return effective === 'metadata';
}

type SheetRow = { path: (typeof nodes.$inferSelect)['path']; indexing: unknown };
const rowKeys = {
  path: nodes.path,
  indexing: sql<unknown>`${nodes.data}->'indexing'`,
};

/** Set on each transaction that changes a file row here (the header says why). */
const keepUpdatedAt = (tx: Pick<typeof db, 'execute'>) =>
  tx.execute(sql`select set_config('mantle.keep_updated_at', 'on', true)`);

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
 * The drawing's crop folder is never made here (a folder not there yet is
 * judged by the Files root right that creating it needs). storeChecks makes it
 * when it files, so a sheet that is then skipped (its bytes changed, no crop
 * endpoint, a cap reached) leaves no empty folder. `dryRun` does not make the
 * Files root a fresh box lacks either, so a dry run writes nothing at all.
 */
export async function storeRefusal(
  ownerId: string,
  sheet: SheetInput,
  opts: { dryRun?: boolean } = {},
): Promise<string | null> {
  const row = await fileDataRow(ownerId, sheet.tableId);
  if (!row) {
    return 'you cannot read its drawing file, so its answers could not be stored; ask someone who can read the drawing to run the check';
  }
  const refused = await fileDataRefusal(ownerId, row);
  if (refused) return `the answers could not be stored: ${refused.message}`;
  if (isSnapshotCopy(row)) {
    return 'the answers could not be stored: this file is a read-only snapshot copy; run the check on the file it was copied from';
  }
  try {
    await assertItemRight(row.id, 'edit');
  } catch (err) {
    return `the answers could not be stored: you may not edit its file (${errorMessage(err).slice(0, 160)}); ask someone who may edit the drawing to run the check, or use dry_run to see the questions`;
  }
  const data = (row.data ?? {}) as Record<string, unknown>;
  if (readIndexWork(data) === 'extract') {
    return 'its file is being read into the brain right now, and an answer filed during that would make the read fail and pay again; call again in a few minutes';
  }
  const revision = sheet.revision ?? '';
  const held = storedChecksOf(data[DWG_ANSWERS_KEY]).filter((c) => c.revision === revision);
  if (bytesOf(held) + ANSWERS_CALL_MARGIN_BYTES > ANSWERS_CAP_BYTES) {
    return `this revision of the drawing already holds ${held.length} answers, and one more call could pass the ${ANSWERS_CAP_BYTES / 1024} KB one file keeps, so nothing was asked; circuit_trace shows the answers it holds, and a new revision of the drawing starts afresh`;
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

/**
 * The list a file row keeps once these answers are in: the newest per circuit,
 * guess and revision, the oldest revision's dropped first past the cap. Null
 * when `revision` alone does not fit, which storeRefusal's margin keeps from
 * happening: its answers are never dropped to make room for each other.
 */
export function answersAfter(
  held: readonly StoredCheck[],
  added: readonly StoredCheck[],
  revision: string,
): StoredCheck[] | null {
  const idOf = (c: StoredCheck) => `${circuitKey(c.circuit ?? '')}|${c.key}|${c.revision}`;
  const replaced = new Set(added.map(idOf));
  let next = [...held.filter((c) => !replaced.has(idOf(c))), ...added];
  while (bytesOf(next) > ANSWERS_CAP_BYTES) {
    const newest = new Map<string, string>();
    for (const c of next) {
      if (c.revision === revision) continue;
      const had = newest.get(c.revision);
      if (had === undefined || had < c.checkedAt) newest.set(c.revision, c.checkedAt);
    }
    if (!newest.size) return null;
    const oldest = [...newest].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))[0]![0];
    next = next.filter((c) => c.revision !== oldest);
  }
  return next;
}

export async function storeChecks(
  ownerId: string,
  sheet: SheetInput,
  circuit: string,
  answers: CheckAnswer[],
  overview: Buffer | null,
  checkedAt: string,
  /** Who runs the call (builtins-circuits.ts callerOf: a kind and a keyed hash,
   *  never a raw id; sealed with the answer). */
  by = '',
): Promise<StoreResult> {
  const fileId = sheet.tableId;
  // Again, after the vision call: a flip while it ran files nothing. This is
  // also the one read of a chain the scope cannot see (turnedPrivate).
  const row = await fileDataRow(ownerId, fileId);
  if (!row) return { error: 'its file is gone, or you no longer read it' };
  const refused = await fileDataRefusal(ownerId, row);
  if (refused) return { error: refused.message };

  // 1. The crops: name-only image files, one folder per drawing.
  const folder = await ensureAutoFiledFolder(ownerId, 'drawing-checks', {
    document: cropDocument(sheet),
  });
  const when = stamp(checkedAt);
  const base = {
    indexing: 'metadata',
    provenance: DRAWING_CHECK_PROVENANCE,
    sourceFileId: sheet.sourceFileId,
    revision: sheet.revision ?? null,
    circuit,
    checkedAt,
  };
  const made: string[] = [];
  /** The crops this call made, removed when its answers are not filed: no
   *  evidence file is left naming answers the file does not hold. */
  const unmake = async () => {
    for (const id of made)
      await deleteFileById({ ownerId, fileId: id, deleteDerived: true }).catch(() => null);
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
  /** Per question, its crops' cell words: each file id with the sha256 of
   *  the bytes stored, sealed with the answer (a drawing check's crop file is
   *  never replaced; the hash says which bytes the answer saw). */
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
        const id = await save(
          `${fileSafe(circuit)}-${when}-${a.q.id}-${c.part + 1}.png`,
          c.png,
          `Image check ${circuit}: ${sheet.title}, ${a.q.id} (${a.q.kind}) crop ${c.part + 1} of ${c.of}`,
          { checkKey: a.q.key, checkKind: a.q.kind, window: c.window, textPx: c.textPx },
        );
        ids.push(cropCellWords(id, createHash('sha256').update(c.png).digest('hex')));
      }
      cropIds.set(a.q.id, ids);
    }
  } catch (err) {
    await unmake();
    return { error: `the crops could not be saved (${errorMessage(err).slice(0, 160)})` };
  }

  // 2. The answers, sealed under the file's id.
  const revision = sheet.revision ?? '';
  const added = answers.map((a): StoredCheck => {
    const ids = cropIds.get(a.q.id) ?? [];
    const crops = [...(overviewId ? [`overview ${overviewId}`] : []), ...ids].join(' ');
    // Every listed alternative fits ALT_MAX (check.ts altsOf); capped here too,
    // the answer and its seal alike, so no stored one is ever longer.
    const alt = (a.alt ?? '').slice(0, ALT_MAX);
    const check: StoredCheck = {
      key: a.q.key,
      kind: a.q.kind,
      circuit,
      node: a.q.node === null ? '' : String(a.q.node),
      handles: a.q.handles.join(' '),
      guess: a.q.guess,
      question: a.q.question,
      answer: a.verdict,
      alt,
      reason: a.reason,
      trust: TRUST[a.verdict],
      model: a.model,
      checkedAt,
      revision,
      file: fileId,
      crops,
      by,
    };
    return { ...check, seal: sealOf(sealFieldsOf(fileId, check)) };
  });
  let why: string | null;
  try {
    why = await withHeads([fileId], 'update', async (tx) => {
      await keepUpdatedAt(tx);
      const [now] = await tx
        .select({ ...rowKeys, held: sql<unknown>`${nodes.data}->${DWG_ANSWERS_KEY}::text` })
        .from(nodes)
        .where(and(eq(nodes.id, fileId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'file')));
      if (!now) return 'its file is gone';
      if (await turnedPrivate(ownerId, now)) return TURNED_PRIVATE;
      const next = answersAfter(storedChecksOf(now.held), added, revision);
      if (!next)
        return `this revision of the drawing fills the ${ANSWERS_CAP_BYTES / 1024} KB one file keeps`;
      await tx
        .update(nodes)
        .set({
          data: sql`coalesce(${nodes.data}, '{}'::jsonb) || ${JSON.stringify({
            [DWG_ANSWERS_KEY]: next,
          })}::jsonb`,
        })
        .where(eq(nodes.id, fileId));
      return null;
    });
  } catch (err) {
    why = errorMessage(err).slice(0, 160);
  }
  if (why) {
    await unmake();
    return { error: why };
  }
  return { stored: answers.length };
}

/** Node data key: the circuit_verify calls claimed on a drawing's file in
 *  the last hour (verify.ts VerifyDeps.claim). Bookkeeping of the server. */
export const VERIFY_RUNS_KEY = DWG_VERIFY_RUNS_KEY;
/** Most claims one file keeps per circuit (circuitKey), each pruned to
 *  the last hour: an hour's worth on one circuit is far fewer (the guard
 *  lets VERIFY_GUARD.perHour rechecks through), and calls on one circuit
 *  never push another circuit's claims out. */
const RUNS_PER_CIRCUIT = 16;
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

/** The calls claimed on these files (verify.ts VerifyDeps.runs): read
 *  only, no lock, for the guard's early look; the claim reads them again
 *  under its lock. */
export async function readVerifyRuns(
  ownerId: string,
  tableIds: readonly string[],
): Promise<VerifyRun[]> {
  const ids = [...new Set(tableIds)];
  if (!ids.length) return [];
  const rows = await db
    .select({ id: nodes.id, runs: sql<unknown>`${nodes.data}->${VERIFY_RUNS_KEY}` })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, ids)));
  return rows.flatMap((r) => runsOf(r.id, r.runs));
}

/**
 * circuit_verify's claim (verify.ts VerifyDeps.claim): in one transaction,
 * the heads of the files it asks about locked and then a lock on the
 * owner's circuit (so two calls on one circuit take turns, whatever sheets
 * each asks about), the claims on every sheet of the circuit go to
 * `refusal`; when it says nothing, this call is recorded on each file it
 * asks about (claims older than an hour dropped) and null comes back. A file
 * turned private since the store's check is refused here too: nothing is filed
 * on it, and nothing is spent.
 */
export async function claimVerifyRun(
  ownerId: string,
  claim: VerifyClaim,
  refusal: (runs: readonly VerifyRun[]) => string | null,
): Promise<string | null> {
  const write = [...new Set(claim.sheets.map((s) => s.tableId))];
  const read = [...new Set([...claim.readFrom, ...write])];
  return withHeads(write, 'update', async (tx) => {
    // One lock per circuit however its name is written (circuitKey).
    const circuit = circuitKey(claim.circuit);
    await advisoryXactLock(tx, `circuit-verify:${ownerId}:${circuit}`, 'hashtextextended');
    await keepUpdatedAt(tx);
    const rows = await tx
      .select({ id: nodes.id, ...rowKeys, runs: sql<unknown>`${nodes.data}->${VERIFY_RUNS_KEY}` })
      .from(nodes)
      .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, read)));
    const runs = rows.flatMap((r) => runsOf(r.id, r.runs));
    const why = refusal(runs);
    if (why) return why;
    for (const row of rows) {
      if (write.includes(row.id) && (await turnedPrivate(ownerId, row))) return TURNED_PRIVATE;
    }
    const since = Date.parse(claim.at) - HOUR;
    for (const s of claim.sheets) {
      const kept = runs
        .filter((r) => r.tableId === s.tableId && Date.parse(r.at) >= since)
        .map(({ tableId: _t, ...r }) => r);
      const all = [
        ...kept,
        { circuit: claim.circuit, by: claim.by, at: claim.at, revision: s.revision },
      ];
      // The newest RUNS_PER_CIRCUIT of each circuit, in their order.
      const left = new Map<string, number>();
      const next = all
        .reverse()
        .filter((r) => {
          const k = circuitKey(r.circuit);
          const n = left.get(k) ?? RUNS_PER_CIRCUIT;
          left.set(k, n - 1);
          return n > 0;
        })
        .reverse();
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
