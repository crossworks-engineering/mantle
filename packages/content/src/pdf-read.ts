/**
 * The core's part of a PDF read (docs/pipelines.md, "The PDF set"): the
 * router and the reader are packages (`pdf-router`, `drawing-pdf`), run by
 * the parser one step a job (./pipeline-runner.ts). What stays here is what
 * only the core holds:
 *
 * - The decider's ask. The router's step returns one `decider` call for a
 *   file its rules leave unsure; the core checks what the step would send
 *   (pdfKindAskOf), asks, and keeps the answer, so the reader's File tab can
 *   hold it, also a shadow answer that is not used.
 * - The stored state of a PDF's bytes a read again works from
 *   (pdfReadAgainOf: one read, fail closed): the kind and the decision it
 *   keeps, and the stat its write is conditional on. The decision reaches
 *   the reader's first step as its `state` (runPackaged's `opts.state`),
 *   never in `request.kind` alone.
 *
 * The sketch read of a scan is not here: it is a core path of its own
 * (server/api/src/agent/extract/pdf-sketch.ts). Nothing is written here:
 * the caller writes at the one write spot.
 */
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import {
  fileDbWordOf,
  isParserUnavailable,
  PAGE_KIND_COLUMNS,
  PAGE_KIND_FROM,
  PDF_KIND_RULES_VERSION,
  PDF_PAGE_WINDOW,
  pageKindsOfRows,
  pdfFileTabOf,
  pdfKindAskOf,
  pdfPageAskOf,
  type PdfKindAsk,
  type PdfKindDecision,
  type PdfPageAsk,
  type PdfPageKind,
  type PipelineManifest,
} from '@mantle/files';
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import { readTabColumns, runTableSql } from '@mantle/tabledb';
import { askCapOf } from './pipeline-agent';
import {
  agentStep,
  isWindowLost,
  pdfWindows,
  runPackaged,
  stepFileOf,
  PipelineRunError,
  windowJob,
  type PipelineAsk,
} from './pipeline-runner';

/** What a PDF's stored File tab says (pdfFileTabOf). */
export type StoredPdf = NonNullable<ReturnType<typeof pdfFileTabOf>>;

/** How the caller asks the decider about an unsure PDF. Null: no answer,
 *  and the file stays unsure. */
export type PdfDecide = (ask: PdfKindAsk) => Promise<PdfKindDecision | null>;

/** The `File` tab of a PDF's database at `abs`, or null: no database, not a
 *  PDF drawing database, or it went just now. */
export async function storedPdfOf(abs: string): Promise<StoredPdf | null> {
  try {
    const r = await runTableSql(abs, 'SELECT * FROM "File"', { cap: 1 });
    return r.rows[0] ? pdfFileTabOf(r.columns, r.rows[0]) : null;
  } catch {
    return null;
  }
}

/** Whether a reindex keeps the text of a PDF whose database is at `abs`
 *  (the file is there): its File tab holds the sketch read, or the tab
 *  cannot be read now (a busy reader pool, no row, another shape). Fail
 *  closed, as pdfReadAgainOf: a tab that cannot be read keeps the paid
 *  text, so a reindex never pays a whole-page OCR again by a read error. */
export async function pdfTextKeptOf(abs: string): Promise<boolean> {
  try {
    const r = await runTableSql(abs, 'SELECT * FROM "File"', { cap: 1 });
    const stored = r.rows[0] ? pdfFileTabOf(r.columns, r.rows[0]) : null;
    return !stored || stored.visionRead;
  } catch {
    return true;
  }
}

/** A file as a conditional write compares it: inode, size and mtime. */
export type FileStamp = { ino: number; size: number; mtimeMs: number };

/**
 * What a read again of a PDF works from (buildFileDatabase, no `parsed`):
 * ONE read of the stored state of these bytes, before the job. It fails
 * CLOSED: what cannot be read is a skip, never "nothing stored".
 *
 * - A database with a sketch read: `sketch` (a read with no model would
 *   lose it).
 * - No database and the word `no-rows`: `not-drawing`. For a PDF that word
 *   is the decider's "document" of an older read (a drawing read always has
 *   its File tab, so it never ends in no rows; and the decider's "document"
 *   is no longer used, so no read gives the word now), but the word does
 *   not say where it came from, so any `no-rows` of a PDF is kept: the safe
 *   side.
 * - A database whose File tab cannot be read, or a stat or a word that
 *   cannot be read: `kept`.
 * - Else the stored File tab (null: no database) and the stat of the
 *   database (null: none) the write is conditional on, and `reroute`: the
 *   stored kind came from older rules (`Rules version`), not from a used
 *   decider answer, so the router names it again with the rules of now (no
 *   ask). The stored answer, a shadow or weak one too, stays in the File
 *   tab (readRouted, ./file-database.ts).
 */
export async function pdfReadAgainOf(names: { sqlite: string; none: string }): Promise<
  | { skip: 'sketch' | 'not-drawing' | 'kept' }
  | {
      skip: null;
      stored: StoredPdf | null;
      since: FileStamp | null;
      reroute: boolean;
      /** The page types of the tab Pages (the router's part 2), put in
       *  again with no ask. */
      pageKinds: PdfPageKind[];
    }
> {
  try {
    const at = statSync(names.sqlite, { throwIfNoEntry: false });
    if (!at) {
      const word = await readFile(names.none, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return '';
        throw err;
      });
      if (fileDbWordOf(word) === 'no-rows') return { skip: 'not-drawing' };
      return { skip: null, stored: null, since: null, reroute: false, pageKinds: [] };
    }
    const r = await runTableSql(names.sqlite, 'SELECT * FROM "File"', { cap: 1 });
    const stored = r.rows[0] ? pdfFileTabOf(r.columns, r.rows[0]) : null;
    if (!stored) return { skip: 'kept' };
    if (stored.visionRead) return { skip: 'sketch' };
    return {
      skip: null,
      stored,
      since: { ino: at.ino, size: at.size, mtimeMs: at.mtimeMs },
      reroute: stored.rulesVersion < PDF_KIND_RULES_VERSION && !stored.decision?.used,
      // In the same fail-closed read: a tab that cannot be read keeps the
      // database, so a read again never loses a paid page answer.
      pageKinds: storedPageKindsOf(names.sqlite),
    };
  } catch {
    return { skip: 'kept' };
  }
}

/** The page types stored in the tab Pages of the database at `abs` (none
 *  for a database with no such tab). Throws what the read throws: the
 *  caller fails closed. */
export function storedPageKindsOf(abs: string): PdfPageKind[] {
  const [rows] = readTabColumns(abs, [{ tab: 'Pages', columns: ['Page', ...PAGE_KIND_COLUMNS] }]);
  return rows ? pageKindsOfRows(rows) : [];
}

/**
 * Whether a file's node holds the text of an older whole-page vision read:
 * `data.vision_model` is set (the extract writes it with the text). A read
 * again tells the reader (readerStateOf), so the File tab can say where the
 * vision text is. A failed read says no: it only names where text is.
 */
export async function pdfNodeVisionOf(fileId: string): Promise<boolean> {
  try {
    const rows = (await db.execute(
      sql`select coalesce(data->>'vision_model', '') <> '' as v from nodes where id = ${fileId}`,
    )) as unknown as { v?: boolean }[];
    return rows[0]?.v === true;
  } catch {
    return false;
  }
}

/** The state the reader's first step gets from the core: the decision,
 *  `facts: true` when its body is the router's page facts, not the file,
 *  and `nodeVision: true` when the file's node holds the text of an older
 *  whole-page vision read (the File tab's `Vision text`). */
export function readerStateOf(
  decision: PdfKindDecision | null,
  facts = false,
  nodeVision = false,
): Record<string, unknown> {
  return {
    decision,
    ...(facts ? { facts: true } : {}),
    ...(nodeVision ? { nodeVision: true } : {}),
  };
}

/**
 * The router's run: the kind of the file, the decider's answer when the
 * router asked (only with `decide`, for a file its rules leave unsure), and
 * the page facts it read (`facts`, none past their cap), read with the
 * title block box of `options` (the read's options, the reader's). A run
 * that names no kind is a failure (PipelineRunError, the word
 * `unreadable`). A typed parser failure throws as for every job.
 */
export async function routePdf(
  router: PipelineManifest,
  bytes: Buffer,
  options: Readonly<Record<string, unknown>>,
  decide: PdfDecide | undefined,
): Promise<{
  kind: string;
  decision: PdfKindDecision | null;
  facts?: Record<string, unknown>;
}> {
  let decision: PdfKindDecision | null = null;
  // One ask a file: the router's cap of the decider is the page cap (part
  // 2), so the file's one ask is held here.
  let asked = false;
  const ask: PipelineAsk | undefined = decide
    ? async (call) => {
        const state = call.worker === 'decider' && !asked ? pdfKindAskOf(call.input) : null;
        if (!state) return { ok: false, error: 'refused' };
        asked = true;
        decision = await decide(state);
        return decision ? { ok: true, output: decision } : { ok: false, error: 'not_available' };
      }
    : undefined;
  const run = await runPackaged(router, bytes, stepFileOf(bytes, 'pdf'), {
    options,
    ...(ask ? { ask } : {}),
  });
  if (run.status !== 'ok' || typeof run.kind !== 'string') {
    throw new PipelineRunError(`${router.id} named no kind (${run.status})`);
  }
  return { kind: run.kind, decision, ...(run.facts ? { facts: run.facts } : {}) };
}

/** The decider's answer for one page, as the caller heard it (PdfPageAnswer
 *  of @mantle/decisions). */
export type PdfPageDecision = {
  kind: string;
  /** The summed chance of the answer's route. */
  confidence: number;
  /** At or over the use's floor. */
  sure: boolean;
  model: string;
  mode: 'shadow' | 'live';
};

/**
 * How the caller asks page types of one file (server/api
 * extract/pdf-kind.ts): given only where the file may have model work and
 * page asks are on for this box (the one guard, pdfPageAsksOn), so at an
 * upload's extract alone.
 */
export type PdfPageDecide = {
  /** The paid asks the box's day cap leaves now. */
  room(): Promise<number>;
  /** The answer kept for this ask (the answer cache: an extract tried
   *  again), or null. Free: it takes no room and no place in the file's
   *  cap. `version`: the router's, in the key, so a new question asks
   *  again. */
  kept(ask: PdfPageAsk, picture: Buffer, version: string): Promise<PdfPageDecision | null>;
  /** One paid page ask: the answer (kept for a retry); null, no answer;
   *  `stop`, ask no more pages of this file (no answer three times in a
   *  row, or the breaker is open). */
  ask(ask: PdfPageAsk, picture: Buffer, version: string): Promise<PdfPageDecision | null | 'stop'>;
  /** The file's asks are over: the breaker hears their one outcome. */
  settle(): void;
};

/** Page asks of one window at once (the M2 bench asked 4 at once). */
const PAGE_ASKS_AT_ONCE = 4;

/** A page's type from its answer (M3: shadow, the rules' kind stays). */
function pageKindOfAnswer(page: number, kind: string, d: PdfPageDecision): PdfPageKind {
  return {
    page,
    kind,
    from: d.sure ? PAGE_KIND_FROM.shadow : PAGE_KIND_FROM.low,
    deciderKind: d.kind,
    deciderConfidence: d.confidence,
  };
}

/** The state's pages of one window: [page, rules kind, why no ask]. */
function windowPagesOf(state: unknown): [number, string, string | null][] {
  const raw =
    state && typeof state === 'object' && Array.isArray((state as { pages?: unknown }).pages)
      ? ((state as { pages: unknown[] }).pages as unknown[])
      : [];
  return raw.filter(
    (p): p is [number, string, string | null] =>
      Array.isArray(p) &&
      Number.isInteger(p[0]) &&
      typeof p[1] === 'string' &&
      (p[2] === null || p[2] === 'blank' || p[2] === 'not drawn'),
  );
}

/**
 * The router's part 2 (docs/pipelines.md, "Page types"; plan page c607711a,
 * M3 in shadow): the type of every page of a PDF, by one ask a page with
 * its picture. Windows of 25 pages (PDF_PAGE_WINDOW), one parser job each,
 * the router's step drawing the window's pictures with no model; then the
 * core checks each ask (pdfPageAskOf, the one check of what leaves the box)
 * and asks, 4 at once.
 *
 * Every cap ends in the rules, never in a wait: past the file's cap (the
 * router's needs.workers.decider), past the day cap (`room`), or after a
 * stop (`ask` says `stop`), the pages left keep their rules kind, and
 * `Kind from` says why. No window is cut past a cap. A window the parser
 * cannot cut or read is `rules: not drawn`. A busy or unavailable parser
 * throws, as every job: the extract is tried again, and the answer cache
 * holds the answers paid. Any other failure ends part 2 with what it has:
 * the shadow never costs a file its database. Nothing is written here.
 *
 * An answer kept in the answer cache (an extract tried again) is taken
 * first and is free: only a real call takes day-cap room and a place in
 * the file's cap. `rows`: the pages that have a row in the Reader's tab
 * Pages; a page with no row is not asked (its answer would stand nowhere),
 * and a window with none is not cut.
 */
export async function pdfPageKindsOf(
  router: PipelineManifest,
  bytes: Buffer,
  options: Readonly<Record<string, unknown>>,
  decide: PdfPageDecide,
  rows: ReadonlySet<number>,
): Promise<PdfPageKind[]> {
  if (rows.size === 0) return [];
  const file = stepFileOf(bytes, 'pdf');
  const cap = askCapOf(router, 'decider');
  const out = new Map<number, PdfPageKind>();
  const rulesOnly = (page: number, kind: string | null, from: string) =>
    out.set(page, { page, kind, from, deciderKind: null, deciderConfidence: null });
  let asked = 0;
  let stopped: string | null = null;
  let total = 0;
  let readTo = 0;
  try {
    for await (const w of pdfWindows(bytes, file.sha256, PDF_PAGE_WINDOW)) {
      total = w.part ? w.part.pagesTotal : w.pagesTotal;
      const from = w.part ? w.part.pageFrom : w.from;
      const to = w.part ? w.part.pageTo : w.to;
      readTo = to;
      let hasRow = false;
      for (let n = from; n <= to && !hasRow; n++) hasRow = rows.has(n);
      if (!hasRow) continue;
      if (!w.part) {
        for (let n = from; n <= to; n++) rulesOnly(n, null, PAGE_KIND_FROM.notDrawn);
        continue;
      }
      const run = await windowJob(() =>
        agentStep(router, w.part!.bytes, file, options, {
          window: { pageFrom: from, pageTo: to, pagesTotal: total },
        }),
      );
      if (isWindowLost(run)) {
        for (let n = from; n <= to; n++) rulesOnly(n, null, PAGE_KIND_FROM.notDrawn);
        continue;
      }
      const kinds = new Map<number, string>();
      for (const [n, kind, why] of windowPagesOf(run.state)) {
        if (n < from || n > to) continue;
        kinds.set(n, kind);
        if (why)
          rulesOnly(n, kind, why === 'blank' ? PAGE_KIND_FROM.blank : PAGE_KIND_FROM.notDrawn);
      }
      const asks: { ask: PdfPageAsk; picture: Buffer; kind: string }[] = [];
      for (const call of run.asks) {
        const ask = call.worker === 'decider' ? pdfPageAskOf(call.input) : null;
        const picture = ask ? run.pictures.get(ask.picture) : undefined;
        if (!ask || !picture || ask.page < from || ask.page > to || out.has(ask.page)) continue;
        if (!rows.has(ask.page)) continue;
        const kind = kinds.get(ask.page) ?? null;
        if (kind !== null) asks.push({ ask, picture, kind });
      }
      // Kept answers first, free (an extract tried again paid for them).
      const kept = await Promise.all(
        asks.map((q) => decide.kept(q.ask, q.picture, router.version).catch(() => null)),
      );
      // The day cap, read once a window (the asks of a window are few).
      let room = Math.max(0, await decide.room());
      const queue: typeof asks = [];
      for (const [i, { ask, picture, kind }] of asks.entries()) {
        const k = kept[i];
        if (k) out.set(ask.page, pageKindOfAnswer(ask.page, kind, k));
        else if (asked >= cap) rulesOnly(ask.page, kind, PAGE_KIND_FROM.cap);
        else if (room <= 0) rulesOnly(ask.page, kind, PAGE_KIND_FROM.dayCap);
        else {
          asked += 1;
          room -= 1;
          queue.push({ ask, picture, kind });
        }
      }
      for (let i = 0; i < queue.length; i += PAGE_ASKS_AT_ONCE) {
        const part = queue.slice(i, i + PAGE_ASKS_AT_ONCE);
        const answers = await Promise.all(
          part.map((q) =>
            stopped ? Promise.resolve(null) : decide.ask(q.ask, q.picture, router.version),
          ),
        );
        for (const [j, a] of answers.entries()) {
          const q = part[j]!;
          if (a === 'stop') stopped = PAGE_KIND_FROM.noAnswer;
          if (a && a !== 'stop') out.set(q.ask.page, pageKindOfAnswer(q.ask.page, q.kind, a));
          else rulesOnly(q.ask.page, q.kind, PAGE_KIND_FROM.noAnswer);
        }
      }
      // A page of the window the step did not name (its read stopped
      // short): no picture.
      for (let n = from; n <= to; n++) {
        if (!out.has(n)) rulesOnly(n, kinds.get(n) ?? null, PAGE_KIND_FROM.notDrawn);
      }
      // Past a cap or a stop, no window more is cut: the pages left are the
      // rules', said below.
      if (stopped) break;
      if (asked >= cap) {
        stopped = PAGE_KIND_FROM.cap;
        break;
      }
      if (room <= 0 && to < total) {
        stopped = PAGE_KIND_FROM.dayCap;
        break;
      }
    }
  } catch (err) {
    if (isParserUnavailable(err)) throw err;
    // Any other failure: the shadow ends with what it has.
    stopped ??= PAGE_KIND_FROM.notDrawn;
  } finally {
    decide.settle();
  }
  if (stopped) for (let n = readTo + 1; n <= total; n++) rulesOnly(n, null, stopped);
  return [...out.values()].sort((a, b) => a.page - b.page);
}
