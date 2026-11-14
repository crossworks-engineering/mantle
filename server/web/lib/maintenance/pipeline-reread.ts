/**
 * The `pipeline-reread` maintenance task: read again the files a built-in
 * pipeline read at an older version, or before stamps (docs/pipelines.md).
 *
 * It takes a file of the named pipeline's extensions that has a database for
 * its bytes, when that database's stamp is missing or older than the
 * pipeline's version. The stamp is the only selector. A file with no database
 * (never read, or only a word) is the job of `dwg-reindex`, and is only
 * counted here.
 *
 * Manual only: `scripts/pipeline-reread.ts --pipeline=<id>`, scoped by file id
 * or folder, at most `--limit` files a run, a dry run unless `--apply`. No
 * cron, no trigger, nothing that runs on its own.
 *
 * Spend: none. It builds with `buildFileDatabase` and passes no parse result
 * and no decider, so no model is asked. It starts no extract job, and changes
 * no summary, passage or embedding: only the file's database is written
 * again. docs/parser.md, "Old DWG files get the reader's result (a person
 * starts it)", says what stays as it was, and why.
 *
 * An `after` pipeline (`--pipeline=site-tags`): the task takes a file of its
 * extensions that has a database whose real tabs carry the pipeline's shape,
 * when the database has no current entry of it in `pipelines_after`
 * (afterIsCurrent: missing, a lower version, or other options). It patches
 * the database with `patchFileDatabase`: the reader's tabs and rows stay,
 * so it runs on a PDF too. It ignores the attach list: the person who runs
 * the task picked the files.
 *
 * `drawing-pdf` takes a dry run only. A PDF's database can hold the decider's
 * answer and the sketch read, both paid for with a model call. A read with no
 * model cannot make them again, so it would lose them. The file's database
 * is kept as it is; a new upload of the file gets a new read.
 *
 * Output is ids, counts and fixed words: safe on a client box.
 */
import { and, asc, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import {
  buildFileDatabase,
  patchFileDatabase,
  readFileDbAfter,
  readFileDbStamp,
} from '@mantle/content/file-database';
import { pipelineStateOf } from '@mantle/content/pipeline-state';
import {
  BUILTIN_PIPELINES,
  afterIsCurrent,
  afterMatches,
  fileDataExt,
  fileDataListKeys,
  fileDataRow,
  fileDbSqlitePath,
  fileDbsWritable,
  fileSha256Of,
  isFileSha256,
  isParserError,
  PARSER_COUNTED_CODES,
  isAfterPipeline,
  readFileNodeBytes,
  readerIsCurrent,
  type PipelineManifest,
  type PipelineStamp,
} from '@mantle/files';
import { isUuid } from '@mantle/std';
import { describeWorkbook } from '@mantle/tabledb';
import {
  BAD_LIMIT,
  Counts,
  flagOf,
  NO_READER,
  noReader,
  READ_ONLY_FOLDER,
  REBUILD_PAGE,
  rebuildLimitOf,
  rowsInScope,
  scopeOf,
  type ReindexScope,
} from './dwg-reindex';

type Print = (line: string) => void;

const TAG = '[pipeline-reread]';

/** The pipelines whose read this task may not repeat, and why. */
const DRY_RUN_ONLY: Readonly<Record<string, string>> = {
  'drawing-pdf':
    "a PDF's database can hold the decider's answer and the sketch read, both paid for with a model call; a read with no model would lose them. The file's database is kept as it is; a new upload of the file gets a new read.",
};

/** The one selector of a reader: a stamp that is missing, of another
 *  pipeline, of a lower version than the pipeline's own, or of other
 *  options (readerIsCurrent, @mantle/files). */
export function readByOlder(
  stamp: PipelineStamp | null,
  pipeline: PipelineManifest,
  optionsHash = '',
): boolean {
  return !readerIsCurrent(stamp, pipeline, optionsHash);
}

/** The pipeline's file names, as a regex source for SQL `~` on a lowered name. */
function namesOf(pipeline: PipelineManifest): string {
  return `\\.(${pipeline.match.ext.join('|')})$`;
}

/** The next page of the pipeline's files in scope, by id. Their keys only: a
 *  `data` bag can hold a document's text. A PDF is asked for by name, as
 *  `dwg-reindex --pdf` does: the data files list leaves PDFs out. */
function candidatePage(pipeline: PipelineManifest, scope: ReindexScope, after?: string) {
  const pdf = pipeline.match.ext.includes('pdf');
  return db
    .select({
      id: nodes.id,
      ownerId: nodes.ownerId,
      path: nodes.path,
      title: nodes.title,
      data: fileDataListKeys(),
    })
    .from(nodes)
    .where(
      and(
        // Its own name filter below: PDFs are taken beside the other files
        // of its extensions (Site tags reads CAD files and PDFs).
        ...rowsInScope(scope, after, undefined, pdf),
        sql`lower(coalesce(${nodes.data}->>'filename', ${nodes.title})) ~ ${namesOf(pipeline)}`,
      ),
    )
    .orderBy(asc(nodes.id))
    .limit(REBUILD_PAGE);
}

type Candidate = Awaited<ReturnType<typeof candidatePage>>[number];

/** What a run does with this row, reading no bytes. `named`: counted, not
 *  listed. */
async function planFor(
  row: Candidate,
  pipeline: PipelineManifest,
  optionsHash: string,
): Promise<{ take: true } | { take: false; named: string } | { take: false; skip: string }> {
  const sha = fileSha256Of(row);
  if (!isFileSha256(sha)) return { take: false, skip: 'no-sha' };
  const abs = await fileDbSqlitePath(row.id, sha);
  if (!abs) return { take: false, named: 'no database' };
  try {
    if (isAfterPipeline(pipeline)) {
      // The one match rule, on the real tabs: no look at the stamp.
      const tabs = describeWorkbook(abs).map((t) => ({
        name: t.name,
        columns: t.columns.map((c) => c.name),
      }));
      if (!afterMatches(pipeline, fileDataExt(row), tabs)) {
        return { take: false, named: 'no match' };
      }
      return afterIsCurrent(await readFileDbAfter(row.id, sha), pipeline, optionsHash)
        ? { take: false, named: 'current' }
        : { take: true };
    }
    const stamp = await readFileDbStamp(row.id, sha);
    return readByOlder(stamp, pipeline, optionsHash)
      ? { take: true }
      : { take: false, named: 'current' };
  } catch {
    return { take: false, skip: 'stamp-unreadable' };
  }
}

/** Read one file again and build. Never throws. What comes back is a fixed
 *  word, safe to print. No parse result and no decider go in, so the read
 *  asks no model. A parser code that counts against the bytes is tried once
 *  more, so the second failure earns its word in this run. */
async function rereadFile(
  row: Candidate,
  pipeline: PipelineManifest,
): Promise<{ key: string; line: string }> {
  const skip = (reason: string) => ({ key: `skipped ${reason}`, line: `skipped: ${reason}` });
  try {
    if (isAfterPipeline(pipeline)) {
      // The patch reads the database, never the bytes.
      const out = await patchFileDatabase({
        fileId: row.id,
        ownerId: row.ownerId,
        sha256: fileSha256Of(row),
        pipeline,
      });
      if (out.status === 'patched') {
        return { key: 'patched', line: `patched (${out.tabs} tabs, ${out.rows} rows)` };
      }
      return skip(out.reason);
    }
    const full = await fileDataRow(row.ownerId, row.id);
    if (!full) return skip('row-gone');
    if (noReader(full)) return skip(NO_READER);
    const loaded = await readFileNodeBytes(full);
    if (!loaded) return skip('bytes-gone');
    const build = () =>
      buildFileDatabase({
        fileId: row.id,
        ownerId: row.ownerId,
        sha256: fileSha256Of(full),
        bytes: loaded.bytes,
        filename: loaded.filename,
      });
    let built: Awaited<ReturnType<typeof build>>;
    try {
      built = await build();
    } catch (err) {
      if (!isParserError(err) || !PARSER_COUNTED_CODES.has(err.code)) throw err;
      built = await build();
    }
    if (built.status === 'built') {
      return { key: 'built', line: `built (${built.tabs} tabs, ${built.rows} rows)` };
    }
    if (built.status === 'none') return { key: `word ${built.word}`, line: `word: ${built.word}` };
    return skip(built.reason);
  } catch (err) {
    if (isParserError(err)) {
      return { key: `parser ${err.code}`, line: `nothing written: parser ${err.code}` };
    }
    const code = (err as { code?: unknown } | null)?.code;
    const named = typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'error';
    return { key: `failed ${named}`, line: `nothing written: failed ${named}` };
  }
}

export type RereadOptions = {
  pipeline: PipelineManifest;
  scope: ReindexScope;
  after?: string;
  limit: number;
  apply: boolean;
};

/** One run. The cap counts files taken, so a current file uses none of it. */
export async function runReread(
  opts: RereadOptions,
  print: Print,
): Promise<{ counts: Counts; last: string | null; cut: boolean }> {
  const counts = new Counts();
  const named = new Set((opts.scope.fileIds ?? []).filter(Boolean));
  let after = opts.after;
  let taken = 0;
  let cut = false;
  let last: string | null = null;
  // The options in force, once for each brain of the run.
  const hashes = new Map<string, Promise<string>>();
  const hashOf = (ownerId: string) => {
    let hash = hashes.get(ownerId);
    if (!hash) {
      hash = pipelineStateOf(ownerId, opts.pipeline).then((s) => s.optionsHash);
      hashes.set(ownerId, hash);
    }
    return hash;
  };
  walk: for (;;) {
    const page = await candidatePage(opts.pipeline, opts.scope, after);
    for (const row of page) {
      named.delete(row.id);
      const plan = await planFor(row, opts.pipeline, await hashOf(row.ownerId));
      if (plan.take) {
        if (taken >= opts.limit) {
          cut = true;
          break walk;
        }
        taken += 1;
      }
      last = row.id;
      if (!plan.take) {
        if ('named' in plan) counts.add(plan.named);
        else {
          counts.add(`skipped ${plan.skip}`);
          print(`  ${row.id}: skipped: ${plan.skip}`);
        }
      } else if (opts.apply) {
        print(`  ${row.id}: reading`);
        const out = await rereadFile(row, opts.pipeline);
        counts.add(out.key);
        print(`  ${row.id}: ${out.line}`);
      } else {
        counts.add('to read');
        print(`  ${row.id}: would read`);
      }
    }
    if (page.length < REBUILD_PAGE) break;
    after = page[page.length - 1]!.id;
  }
  for (const id of cut ? [] : named) {
    counts.add('skipped not-a-candidate');
    print(`  ${id}: skipped: not-a-candidate`);
  }
  return { counts, last, cut };
}

/** The task, as scripts/pipeline-reread.ts runs it: the exit code. */
export async function runPipelineReread(argv: readonly string[], print: Print): Promise<number> {
  const id = flagOf(argv, 'pipeline');
  const pipeline = BUILTIN_PIPELINES.find((p) => p.id === id);
  if (!pipeline) {
    const ids = BUILTIN_PIPELINES.map((p) => p.id).join(', ');
    print(`${TAG} --pipeline=<id> is needed, one of: ${ids}. Nothing done.`);
    return 2;
  }
  const scope = scopeOf(argv);
  const after = flagOf(argv, 'after');
  const bad = [...(scope.fileIds ?? []), ...(scope.folderId ? [scope.folderId] : []), after].find(
    (v) => v !== undefined && !isUuid(v),
  );
  if (bad !== undefined) {
    print(`${TAG} not an id: ${bad}. Nothing done.`);
    return 2;
  }
  const apply = argv.includes('--apply');
  const refused = DRY_RUN_ONLY[pipeline.id];
  if (apply && refused) {
    print(`${TAG} ${pipeline.id} takes a dry run only: ${refused} Nothing done.`);
    return 2;
  }
  const limit = rebuildLimitOf(flagOf(argv, 'limit'));
  if (limit === null) {
    print(`${TAG} ${BAD_LIMIT}`);
    return 2;
  }
  if (apply && !(await fileDbsWritable())) {
    print(`${TAG} ${READ_ONLY_FOLDER}`);
    return 1;
  }
  print(
    `${TAG} ${pipeline.id} at ${pipeline.version}: files read at an older version or before stamps`,
  );
  const { counts, last, cut } = await runReread(
    { pipeline, scope, limit, apply, ...(after ? { after } : {}) },
    print,
  );
  print(`${TAG} ${apply ? 'done' : 'DRY RUN'}: ${counts.text}`);
  if (cut) print(`${TAG} cut at --limit=${limit}; go on with --after=${last}`);
  else if (last) print(`${TAG} the end of the list; the last id was ${last}`);
  if (!apply) print(`${TAG} pass --apply to read them${refused ? ' (not for this pipeline)' : ''}`);
  return 0;
}
