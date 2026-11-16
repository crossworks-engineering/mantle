/**
 * The `pipeline-compare` maintenance task: the same-result proof of a
 * pipeline on real files (docs/pipelines.md, "Compare a pipeline with what it
 * wrote"). For each file that has a database of the named pipeline, it runs
 * the pipeline now with no write, the path of "Test on one file", and
 * compares with the stored database: the tab names, the columns of each tab,
 * the row count of each tab, and one hash of each tab's rows. The stored
 * databases were written by the old path, so after a reader moves to a
 * package this is the proof that the new path gives the same rows.
 *
 * Read-only and model-free. Nothing of a file is written: the fresh rows go
 * to a scratch SQLite in the temp folder, through the same writer as a real
 * build, so both sides are read the same way, and it is removed at once. A
 * parser failure counts against nothing (a ledger that keeps nothing). A PDF
 * whose kind the decider gave gets that stored answer back as the decider,
 * so the run asks no model; a PDF with a sketch read, or with no stored
 * kind, is not compared.
 *
 * `--older`: a reader's database written before stamps (no stamp at all,
 * the reader of its extension is this one: pipelineReadOf's version null)
 * is compared too, against a run now with the box's options, and counted
 * in its own words (`equal (before stamps)`). A stamp of an older version
 * or of other options stays `older`: its rows may differ by design.
 *
 * Manual only: `scripts/pipeline-compare.ts --pipeline=<id> [--older]`, scoped
 * by file id or folder, a dry run (the count) unless `--apply`, at most `--limit`
 * files a run (100 by default, 1,000 at most), and no run while the extract
 * queue is busy. No route and no tool. One maintain run at a time on a box.
 *
 * Output is numbers and fixed words only, and the last id to go on from:
 * safe on a client box. A run with a difference ends with one line of where
 * it is (`different by tab: Symbols 28 (hash: SVG 28)`): the tab and column
 * names of a built-in pipeline are Mantle's own words; those of a
 * spreadsheet or an own pipeline are the person's, so they are named by
 * their place only (namesArePrintable).
 */
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureWorkbookDoc } from '@mantle/content-core/table-model';
import {
  afterSheetsOf,
  parseFileSheets,
  readFileDbAfter,
  readFileDbStamp,
  tabsOfSheets,
} from '@mantle/content/file-database';
import { storedPdfOf } from '@mantle/content/pdf-read';
import { pipelineStateOf } from '@mantle/content/pipeline-state';
import { writeFileDatabaseDoc } from '@mantle/content/table-broker';
import { extractQueueBusy } from '@mantle/db';
import {
  afterIsCurrent,
  BUILTIN_PIPELINES,
  CLOCK_COLUMNS,
  fileDataExt,
  fileDataRefusal,
  fileDataRow,
  fileDbSqlitePath,
  fileSha256Of,
  isAfterPipeline,
  isFileSha256,
  isParserError,
  pipelineReadOf,
  readFileNodeBytes,
  readerIsCurrent,
  withParserScope,
  type ParserFailureLedger,
  type PipelineStamp,
  type PipelineManifest,
} from '@mantle/files';
import type { ParsedSheet } from '@mantle/files/sheet-to-grid';
import { isUuid } from '@mantle/std';
import { describeWorkbook, importMaxRows, scanTabColumns } from '@mantle/tabledb';
import {
  BAD_LIMIT,
  Counts,
  flagOf,
  REBUILD_PAGE,
  rebuildLimitOf,
  scopeOf,
  type ReindexScope,
} from './dwg-reindex';
import { candidatePage } from './pipeline-reread';
import type { BoxPipelines } from '@mantle/content/pipeline-registry';

type Print = (line: string) => void;

const TAG = '[pipeline-compare]';

/** A test counts no failure against the bytes: the compare is no read. */
const NO_LEDGER: ParserFailureLedger = {
  get: () => Promise.resolve(null),
  add: () => Promise.resolve(0),
};

/** One tab of a database, as the compare sees it: `columnHashes` is one hash
 *  of each column's cells, so a `hash` difference can name its columns. */
export type TabSum = {
  name: string;
  columns: string[];
  rows: number;
  hash: string;
  columnHashes: string[];
};

/** The tabs the `after` pipelines of the box that match `ext` declare:
 *  never the reader's own. An after pipeline that never runs on the file
 *  type patched nothing in, so a tab of the same name there is the reader's. */
const afterTabsOf = (ext: string, pipelines: BoxPipelines): string[] =>
  pipelines.after.filter((p) => p.match.ext.includes(ext)).flatMap((p) => p.produces.tabs ?? []);

/** The tabs of the database at `abs`, read only: `only` these tab names, or
 *  all but those it should `leaveOut`. A clock column (CLOCK_COLUMNS) is
 *  hashed as null, on both sides: its name is in the columns, its cells are
 *  another time on every read. */
export function tabSumsOf(
  abs: string,
  pick: { only?: readonly string[]; leaveOut?: readonly string[] } = {},
): TabSum[] {
  const only = pick.only ? new Set(pick.only) : null;
  const out = new Set(pick.leaveOut ?? []);
  return describeWorkbook(abs)
    .filter((t) => (!only || only.has(t.name)) && !out.has(t.name))
    .map((t) => {
      const columns = t.columns.map((c) => c.name);
      const clock = columns.map((c) => CLOCK_COLUMNS.get(t.name)?.includes(c) === true);
      // Read by the stored names: they are unique, a display name may not be
      // (a repeated header), and two of one name would read as one.
      const stored = t.columns.map((c) => c.physical);
      const hash = createHash('sha256');
      const perColumn = stored.map(() => createHash('sha256'));
      let rows = 0;
      scanTabColumns(
        abs,
        t.name,
        stored,
        { maxRows: importMaxRows() + 1, cellMaxChars: Number.MAX_SAFE_INTEGER },
        (row) => {
          rows += 1;
          const cells = stored.map((p, i) => (clock[i] ? null : (row[p] ?? null)));
          hash.update(`${JSON.stringify(cells)}\n`);
          cells.forEach((c, i) => perColumn[i]!.update(`${JSON.stringify(c)}\n`));
          return true;
        },
      );
      return {
        name: t.name,
        columns,
        rows,
        hash: hash.digest('hex'),
        columnHashes: perColumn.map((c) => c.digest('hex')),
      };
    });
}

/** One difference between two databases, and where: the tab (by its name
 *  and place) and, for a `hash`, the columns whose cells differ. A `tabs`
 *  difference names a tab on one side only (`side`), or no tab when the
 *  same tabs come in another order. */
export type Difference = {
  kind: 'tabs' | 'columns' | 'rows' | 'hash';
  tab: { name: string; index: number; side?: 'stored' | 'now' } | null;
  columns: { name: string; index: number }[];
};

/** Each difference between two databases, none when equal. */
export function differencesAt(stored: readonly TabSum[], fresh: readonly TabSum[]): Difference[] {
  const names = (s: readonly TabSum[]) => s.map((t) => t.name);
  if (names(stored).join('\n') !== names(fresh).join('\n')) {
    const onlyIn = (a: readonly TabSum[], b: readonly TabSum[], side: 'stored' | 'now') => {
      const other = new Set(names(b));
      return a.flatMap((t, index): Difference[] =>
        other.has(t.name)
          ? []
          : [{ kind: 'tabs', tab: { name: t.name, index, side }, columns: [] }],
      );
    };
    const out = [...onlyIn(stored, fresh, 'stored'), ...onlyIn(fresh, stored, 'now')];
    return out.length > 0 ? out : [{ kind: 'tabs', tab: null, columns: [] }];
  }
  return stored.flatMap((a, index): Difference[] => {
    const b = fresh[index]!;
    const tab = { name: a.name, index };
    if (a.columns.join('\n') !== b.columns.join('\n'))
      return [{ kind: 'columns', tab, columns: [] }];
    if (a.rows !== b.rows) return [{ kind: 'rows', tab, columns: [] }];
    if (a.hash === b.hash) return [];
    const columns = a.columns.flatMap((name, i) =>
      a.columnHashes[i] === b.columnHashes[i] ? [] : [{ name, index: i }],
    );
    return [{ kind: 'hash', tab, columns }];
  });
}

/** The kinds of difference between two databases, none when equal. */
export function differencesOf(stored: readonly TabSum[], fresh: readonly TabSum[]): string[] {
  return [...new Set(differencesAt(stored, fresh).map((d) => d.kind))];
}

/** Whether the compare may print the tab and column names of `pipeline`'s
 *  databases. Those of a built-in pipeline are Mantle's own words, but a
 *  spreadsheet's (`sheet`) are the person's, as are an own pipeline's: for
 *  them a tab or column is named by its place only ("tab 2", "column 3"). */
export function namesArePrintable(pipeline: Pick<PipelineManifest, 'id'>): boolean {
  return pipeline.id !== 'sheet' && BUILTIN_PIPELINES.some((p) => p.id === pipeline.id);
}

/** A tab or column as the summary prints it: its name when printable, else
 *  its place, counted from 1. */
export const labelOf = (printable: boolean, word: 'tab' | 'column', name: string, index: number) =>
  printable ? name : `${word} ${index + 1}`;

/** Where the differences are, summed over the files: by tab, then by kind,
 *  and for a `hash` by column. Its text is counts and labels (labelOf). */
export class Where extends Map<string, { files: number; kinds: Counts; columns: Counts }> {
  addFile(differences: readonly Difference[], printable: boolean) {
    const seen = new Set<string>();
    for (const d of differences) {
      const tab = d.tab ? labelOf(printable, 'tab', d.tab.name, d.tab.index) : '(tab order)';
      let w = this.get(tab);
      if (!w) {
        w = { files: 0, kinds: new Counts(), columns: new Counts() };
        this.set(tab, w);
      }
      if (!seen.has(tab)) w.files += 1;
      seen.add(tab);
      w.kinds.add(d.tab?.side ? `only ${d.tab.side}` : d.kind);
      for (const c of d.columns) w.columns.add(labelOf(printable, 'column', c.name, c.index));
    }
  }
  get text(): string {
    const pairs = (c: Counts) => [...c].map(([k, n]) => `${k} ${n}`).join(', ');
    return [...this]
      .map(([tab, w]) => {
        const kinds = [...w.kinds].map(([k, n]) =>
          k === 'hash' && w.columns.size > 0 ? `hash: ${pairs(w.columns)}` : `${k} ${n}`,
        );
        return `${tab} ${w.files} (${kinds.join(', ')})`;
      })
      .join(', ');
  }
}

/** The fresh sheets as the stored database would hold them: written by the
 *  same writer to a scratch file, read back, removed. */
function freshSums(sheets: readonly ParsedSheet[]): TabSum[] {
  const abs = path.join(os.tmpdir(), `pipeline-compare-${randomUUID()}.sqlite`);
  try {
    writeFileDatabaseDoc(abs, ensureWorkbookDoc({ tabs: tabsOfSheets(sheets) }), {
      fileId: randomUUID(),
      ownerId: randomUUID(),
    });
    return tabSumsOf(abs);
  } finally {
    for (const end of ['', '-wal', '-shm', '-journal']) rmSync(`${abs}${end}`, { force: true });
  }
}

type Candidate = Awaited<ReturnType<typeof candidatePage>>[number];

/** Whether this reader read the database before stamps: no stamp, and it is
 *  the reader of the file's extension (pipelineReadOf, the one rule of
 *  "older", gives no version). Never so for an `after` pipeline. */
export function readBeforeStamps(
  pipeline: PipelineManifest,
  ext: string,
  stamp: PipelineStamp | null,
  pipelines: BoxPipelines,
): boolean {
  if (isAfterPipeline(pipeline)) return false;
  return (
    pipelineReadOf(pipeline, { ext, stamp, after: undefined }, '', pipelines)?.version === null
  );
}

/** The words of the files compared because of `--older`. */
const BEFORE_STAMPS = ' (before stamps)';

/** Compare one file. Never throws; gives the count keys of its outcome.
 *  `older`: a database before stamps is compared too (readBeforeStamps). */
export async function compareFile(
  row: Candidate,
  pipeline: PipelineManifest,
  state: { options: Readonly<Record<string, unknown>>; optionsHash: string },
  pipelines: BoxPipelines,
  older = false,
  /** Where a difference is, added to by a different file. */
  where?: Where,
): Promise<string[]> {
  const no = (why: string) => [`not compared ${why}`];
  // The outcome of a database before stamps, in its own words.
  let tag = '';
  try {
    const sha = fileSha256Of(row);
    if (!isFileSha256(sha)) return no('no-sha');
    const abs = await fileDbSqlitePath(row.id, sha);
    if (!abs) return no('no-database');
    const full = await fileDataRow(row.ownerId, row.id);
    if (!full) return no('row-gone');
    const refused = await fileDataRefusal(row.ownerId, full, pipelines.dbExts);
    if (refused) return no(refused.code);

    let stored: TabSum[];
    let sheets: ParsedSheet[];
    if (isAfterPipeline(pipeline)) {
      stored = tabSumsOf(abs, { only: pipeline.produces.tabs ?? [] });
      if (stored.length === 0) return no('no-tabs-of-it');
      // Tabs written at an older version or with other options: not compared,
      // as for a reader (pipeline-reread's rule).
      if (!afterIsCurrent(await readFileDbAfter(row.id, sha), pipeline, state.optionsHash)) {
        return no('older');
      }
      // A package: one parser job, read-only, no ledger, as a reader below.
      sheets = (
        await withParserScope({ failures: NO_LEDGER }, () =>
          afterSheetsOf(pipeline, abs, state.options),
        )
      ).sheets;
    } else {
      const ext = fileDataExt(full);
      const stamp = await readFileDbStamp(row.id, sha);
      if (older && readBeforeStamps(pipeline, ext, stamp, pipelines)) tag = BEFORE_STAMPS;
      else if (!readerIsCurrent(stamp, pipeline, state.optionsHash)) return no('older');
      const isPdf = pipeline.match.ext.includes('pdf');
      const pdf = isPdf ? await storedPdfOf(abs) : null;
      // No stored kind: a run now would need the router, so not compared.
      if (isPdf && !pdf) return no('no-stored-kind');
      if (pdf?.visionRead) return no('sketch-read');
      const loaded = await readFileNodeBytes(full);
      if (!loaded) return no('bytes-gone');
      if (createHash('sha256').update(loaded.bytes).digest('hex') !== sha) return no('stale');
      const parsed = await withParserScope({ failures: NO_LEDGER }, () =>
        parseFileSheets(loaded.bytes, ext, {
          pipelines,
          options: state.options,
          // The stored kind and decider's answer, given back: the router does
          // not run and no model is asked (as a read again).
          ...(pdf ? { pdfStored: { kind: pdf.kind, decision: pdf.decision } } : {}),
        }),
      );
      // The stored database has rows; a run now that gives none is different.
      if (parsed.kind === 'none') {
        return [`different${tag}`, `different${tag} word-${parsed.word}`];
      }
      if (parsed.kind !== 'sheets') {
        return [`different${tag}`, `different${tag} ${parsed.kind}`];
      }
      // The tabs an `after` pipeline patched in are not the reader's.
      stored = tabSumsOf(abs, { leaveOut: afterTabsOf(ext, pipelines) });
      sheets = parsed.sheets;
    }
    const differences = differencesAt(stored, freshSums(sheets));
    where?.addFile(differences, namesArePrintable(pipeline));
    const kinds = [...new Set(differences.map((d) => d.kind))];
    return kinds.length === 0
      ? [`equal${tag}`]
      : [`different${tag}`, ...kinds.map((k) => `different${tag} ${k}`)];
  } catch (err) {
    if (isParserError(err)) return no(`parser-${err.code}`);
    return no('error');
  }
}

export type CompareOptions = {
  pipeline: PipelineManifest;
  /** The pipelines of the box (boxPipelinesOfTask). */
  pipelines: BoxPipelines;
  scope: ReindexScope;
  after?: string;
  limit: number;
  apply: boolean;
  /** `--older`: compare the databases before stamps too. */
  older?: boolean;
};

/** One run: the files of the pipeline's extensions that have a database,
 *  in id order, at most `limit` compared. */
export async function runCompare(
  opts: CompareOptions,
  print: Print,
): Promise<{ counts: Counts; where: Where; last: string | null; cut: boolean }> {
  const counts = new Counts();
  const where = new Where();
  const states = new Map<
    string,
    Promise<{ options: Readonly<Record<string, unknown>>; optionsHash: string }>
  >();
  const stateOf = (ownerId: string) => {
    let s = states.get(ownerId);
    if (!s) {
      s = pipelineStateOf(ownerId, opts.pipeline);
      states.set(ownerId, s);
    }
    return s;
  };
  let after = opts.after;
  let taken = 0;
  let cut = false;
  let last: string | null = null;
  walk: for (;;) {
    const page = await candidatePage(opts.pipeline, opts.scope, opts.pipelines.dbExts, after);
    for (const row of page) {
      const sha = fileSha256Of(row);
      if (!isFileSha256(sha) || !(await fileDbSqlitePath(row.id, sha))) {
        last = row.id;
        counts.add('no database');
        continue;
      }
      if (taken >= opts.limit) {
        cut = true;
        break walk;
      }
      taken += 1;
      last = row.id;
      if (!opts.apply) {
        // With --older the count names the databases before stamps: a
        // read of the stamp only, as the run decides it.
        const before =
          opts.older === true &&
          readBeforeStamps(
            opts.pipeline,
            fileDataExt(row),
            await readFileDbStamp(row.id, sha),
            opts.pipelines,
          );
        counts.add(before ? `to compare${BEFORE_STAMPS}` : 'to compare');
        continue;
      }
      for (const key of await compareFile(
        row,
        opts.pipeline,
        await stateOf(row.ownerId),
        opts.pipelines,
        opts.older === true,
        where,
      )) {
        counts.add(key);
      }
      if (taken % 25 === 0) print(`${TAG} ${taken} compared: ${counts.text}`);
    }
    if (page.length < REBUILD_PAGE) break;
    after = page[page.length - 1]!.id;
  }
  return { counts, where, last, cut };
}

/** The task, as scripts/pipeline-compare.ts runs it: the exit code.
 *  `pipelinesOf`: gives the box's (boxPipelinesOfTask), asked after the
 *  checks of the other arguments. A router is no id here: it
 *  has no database of its own to compare (`acted`). */
export async function runPipelineCompare(
  argv: readonly string[],
  print: Print,
  pipelinesOf: () => Promise<BoxPipelines>,
): Promise<number> {
  const scope = scopeOf(argv);
  const after = flagOf(argv, 'after');
  const bad = [...(scope.fileIds ?? []), ...(scope.folderId ? [scope.folderId] : []), after].find(
    (v) => v !== undefined && !isUuid(v),
  );
  if (bad !== undefined) {
    print(`${TAG} not an id. Nothing done.`);
    return 2;
  }
  const limit = rebuildLimitOf(flagOf(argv, 'limit'));
  if (limit === null) {
    print(`${TAG} ${BAD_LIMIT}`);
    return 2;
  }
  const pipelines = await pipelinesOf();
  const id = flagOf(argv, 'pipeline');
  const pipeline = pipelines.acted.find((p) => p.id === id);
  if (!pipeline) {
    const ids = pipelines.acted.map((p) => p.id).join(', ');
    print(`${TAG} --pipeline=<id> is needed, one of: ${ids}. Nothing done.`);
    return 2;
  }
  const apply = argv.includes('--apply');
  const older = argv.includes('--older');
  if (apply && (await extractQueueBusy())) {
    print(`${TAG} busy: the extract queue is working. Nothing compared; run it again later.`);
    return 0;
  }
  print(
    `${TAG} ${pipeline.id} at ${pipeline.version}: the stored databases against a run now${
      older ? ', those before stamps too' : ''
    }`,
  );
  const { counts, where, last, cut } = await runCompare(
    { pipeline, pipelines, scope, limit, apply, older, ...(after ? { after } : {}) },
    print,
  );
  print(`${TAG} ${apply ? 'done' : 'DRY RUN'}: ${counts.text}`);
  if (where.size > 0) print(`${TAG} different by tab: ${where.text}`);
  if (cut) print(`${TAG} cut at --limit=${limit}; go on with --after=${last}`);
  if (!apply) print(`${TAG} pass --apply to compare them`);
  return 0;
}
