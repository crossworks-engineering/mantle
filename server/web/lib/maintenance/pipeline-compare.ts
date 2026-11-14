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
 * so the run asks no model; a PDF with a sketch read is not compared.
 *
 * Manual only: `scripts/pipeline-compare.ts --pipeline=<id>`, scoped by file
 * id or folder, a dry run (the count) unless `--apply`, at most `--limit`
 * files a run (100 by default, 1,000 at most), and no run while the extract
 * queue is busy. No route and no tool. One maintain run at a time on a box.
 *
 * Output is numbers and fixed words only, and the last id to go on from:
 * safe on a client box.
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
import { pipelineStateOf } from '@mantle/content/pipeline-state';
import { writeFileDatabaseDoc } from '@mantle/content/table-broker';
import { extractQueueBusy } from '@mantle/db';
import {
  ACTED_PIPELINES,
  AFTER_PIPELINES,
  afterIsCurrent,
  fileDataExt,
  fileDataRefusal,
  fileDataRow,
  fileDbSqlitePath,
  fileSha256Of,
  isAfterPipeline,
  isFileSha256,
  isParserError,
  pdfFileTabOf,
  readFileNodeBytes,
  readerIsCurrent,
  withParserScope,
  type ParserFailureLedger,
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

type Print = (line: string) => void;

const TAG = '[pipeline-compare]';

/** A test counts no failure against the bytes: the compare is no read. */
const NO_LEDGER: ParserFailureLedger = {
  get: () => Promise.resolve(null),
  add: () => Promise.resolve(0),
};

/** One tab of a database, as the compare sees it. */
export type TabSum = { name: string; columns: string[]; rows: number; hash: string };

/** The tabs the `after` pipelines that match `ext` declare: never the
 *  reader's own. An after pipeline that never runs on the file type patched
 *  nothing in, so a tab of the same name there is the reader's. */
const afterTabsOf = (ext: string): string[] =>
  AFTER_PIPELINES.filter((p) => p.match.ext.includes(ext)).flatMap((p) => p.produces.tabs ?? []);

/** The tabs of the database at `abs`, read only: `only` these tab names, or
 *  all but those it should `leaveOut`. */
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
      const hash = createHash('sha256');
      let rows = 0;
      scanTabColumns(
        abs,
        t.name,
        columns,
        { maxRows: importMaxRows() + 1, cellMaxChars: Number.MAX_SAFE_INTEGER },
        (row) => {
          rows += 1;
          hash.update(`${JSON.stringify(columns.map((c) => row[c] ?? null))}\n`);
          return true;
        },
      );
      return { name: t.name, columns, rows, hash: hash.digest('hex') };
    });
}

/** The kinds of difference between two databases, none when equal. */
export function differencesOf(stored: readonly TabSum[], fresh: readonly TabSum[]): string[] {
  const names = (s: readonly TabSum[]) => s.map((t) => t.name).join('\n');
  if (names(stored) !== names(fresh)) return ['tabs'];
  const out = new Set<string>();
  stored.forEach((a, i) => {
    const b = fresh[i]!;
    if (a.columns.join('\n') !== b.columns.join('\n')) out.add('columns');
    else if (a.rows !== b.rows) out.add('rows');
    else if (a.hash !== b.hash) out.add('hash');
  });
  return [...out];
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

/** The stored File tab of a PDF: its decider's answer, and whether the
 *  sketch read ran. */
function storedPdf(abs: string): ReturnType<typeof pdfFileTabOf> {
  const tab = describeWorkbook(abs).find((t) => t.name === 'File');
  if (!tab) return null;
  const columns = tab.columns.map((c) => c.name);
  let row: unknown[] | null = null;
  scanTabColumns(abs, 'File', columns, { maxRows: 1, cellMaxChars: 4_096 }, (r) => {
    row = columns.map((c) => r[c] ?? null);
    return false;
  });
  return row ? pdfFileTabOf(columns, row) : null;
}

type Candidate = Awaited<ReturnType<typeof candidatePage>>[number];

/** Compare one file. Never throws; gives the count keys of its outcome. */
export async function compareFile(
  row: Candidate,
  pipeline: PipelineManifest,
  state: { options: Readonly<Record<string, unknown>>; optionsHash: string },
): Promise<string[]> {
  const no = (why: string) => [`not compared ${why}`];
  try {
    const sha = fileSha256Of(row);
    if (!isFileSha256(sha)) return no('no-sha');
    const abs = await fileDbSqlitePath(row.id, sha);
    if (!abs) return no('no-database');
    const full = await fileDataRow(row.ownerId, row.id);
    if (!full) return no('row-gone');
    const refused = await fileDataRefusal(row.ownerId, full);
    if (refused) return no(refused.code);

    let stored: TabSum[];
    let sheets: ParsedSheet[];
    if (isAfterPipeline(pipeline)) {
      const after = AFTER_PIPELINES.find((p) => p.id === pipeline.id)!;
      stored = tabSumsOf(abs, { only: after.produces.tabs ?? [] });
      if (stored.length === 0) return no('no-tabs-of-it');
      // Tabs written at an older version or with other options: not compared,
      // as for a reader (pipeline-reread's rule).
      if (!afterIsCurrent(await readFileDbAfter(row.id, sha), pipeline, state.optionsHash)) {
        return no('older');
      }
      // A package: one parser job, read-only, no ledger, as a reader below.
      sheets = (
        await withParserScope({ failures: NO_LEDGER }, () =>
          afterSheetsOf(after.id, abs, state.options),
        )
      ).sheets;
    } else {
      if (!readerIsCurrent(await readFileDbStamp(row.id, sha), pipeline, state.optionsHash)) {
        return no('older');
      }
      const pdf = pipeline.match.ext.includes('pdf') ? storedPdf(abs) : null;
      if (pdf?.visionRead) return no('sketch-read');
      const loaded = await readFileNodeBytes(full);
      if (!loaded) return no('bytes-gone');
      if (createHash('sha256').update(loaded.bytes).digest('hex') !== sha) return no('stale');
      const decision = pdf?.decision ?? null;
      const ext = fileDataExt(full);
      const parsed = await withParserScope({ failures: NO_LEDGER }, () =>
        parseFileSheets(loaded.bytes, ext, {
          options: state.options,
          // The stored answer of the decider, given back: no model is asked.
          ...(decision ? { pdfKind: async () => decision } : {}),
        }),
      );
      // The stored database has rows; a run now that gives none is different.
      if (parsed.kind === 'none') return ['different', `different word-${parsed.word}`];
      if (parsed.kind !== 'sheets') return ['different', `different ${parsed.kind}`];
      // The tabs an `after` pipeline patched in are not the reader's.
      stored = tabSumsOf(abs, { leaveOut: afterTabsOf(ext) });
      sheets = parsed.sheets;
    }
    const kinds = differencesOf(stored, freshSums(sheets));
    return kinds.length === 0 ? ['equal'] : ['different', ...kinds.map((k) => `different ${k}`)];
  } catch (err) {
    if (isParserError(err)) return no(`parser-${err.code}`);
    return no('error');
  }
}

export type CompareOptions = {
  pipeline: PipelineManifest;
  scope: ReindexScope;
  after?: string;
  limit: number;
  apply: boolean;
};

/** One run: the files of the pipeline's extensions that have a database,
 *  in id order, at most `limit` compared. */
export async function runCompare(
  opts: CompareOptions,
  print: Print,
): Promise<{ counts: Counts; last: string | null; cut: boolean }> {
  const counts = new Counts();
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
    const page = await candidatePage(opts.pipeline, opts.scope, after);
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
        counts.add('to compare');
        continue;
      }
      for (const key of await compareFile(row, opts.pipeline, await stateOf(row.ownerId))) {
        counts.add(key);
      }
      if (taken % 25 === 0) print(`${TAG} ${taken} compared: ${counts.text}`);
    }
    if (page.length < REBUILD_PAGE) break;
    after = page[page.length - 1]!.id;
  }
  return { counts, last, cut };
}

/** The pipeline a run names, or undefined. A router is no id here: it has
 *  no database of its own to compare (ACTED_PIPELINES). */
function pipelineOf(id: string | undefined): PipelineManifest | undefined {
  return ACTED_PIPELINES.find((p) => p.id === id);
}

/** The task, as scripts/pipeline-compare.ts runs it: the exit code. */
export async function runPipelineCompare(argv: readonly string[], print: Print): Promise<number> {
  const id = flagOf(argv, 'pipeline');
  const pipeline = pipelineOf(id);
  if (!pipeline) {
    const ids = ACTED_PIPELINES.map((p) => p.id).join(', ');
    print(`${TAG} --pipeline=<id> is needed, one of: ${ids}. Nothing done.`);
    return 2;
  }
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
  const apply = argv.includes('--apply');
  if (apply && (await extractQueueBusy())) {
    print(`${TAG} busy: the extract queue is working. Nothing compared; run it again later.`);
    return 0;
  }
  print(`${TAG} ${pipeline.id} at ${pipeline.version}: the stored databases against a run now`);
  const { counts, last, cut } = await runCompare(
    { pipeline, scope, limit, apply, ...(after ? { after } : {}) },
    print,
  );
  print(`${TAG} ${apply ? 'done' : 'DRY RUN'}: ${counts.text}`);
  if (cut) print(`${TAG} cut at --limit=${limit}; go on with --after=${last}`);
  if (!apply) print(`${TAG} pass --apply to compare them`);
  return 0;
}
