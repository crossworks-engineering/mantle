/**
 * Memory benchmark: LoCoMo and LongMemEval, run end to end through the real
 * brain (ingest → extract → retrieve → answer → judge). See docs/benchmarks.md.
 *
 *   BENCH_PG_ADMIN_URL=postgres://postgres:pw@localhost:55440/postgres \
 *   BENCH_OPENROUTER_API_KEY=... \
 *   pnpm -C server/api bench:memory --dataset=locomo --haystacks=1 --questions=20 --max-usd=2
 *
 * Every haystack gets its own scratch database, cloned from one migrated
 * template, on the Postgres server BENCH_PG_ADMIN_URL names. Run it against a
 * throwaway Postgres, never a brain's: it only ever creates and drops
 * databases named mantle_bench_*, but it needs a superuser to do so.
 *
 * Manual runs only. Nothing schedules this: every run spends real money, and
 * --max-usd is a hard stop (checked before each haystack starts, and by each
 * haystack before each question). --dry-run prints the plan and an estimate.
 *
 * Output: <out>/results.jsonl (one line per question), <out>/summary.json and
 * <out>/report.md. --resume=<out> skips haystacks already written there.
 *
 * --snapshot=<name> keeps each haystack's ingested database as
 * mantle_bsnap_<name>_<haystack> and reuses it when it exists: retrieval and
 * answer changes then compare on the SAME ingest (no extraction spend, no
 * extraction noise). A snapshot holds the schema of the code that made it.
 * --retrieve-only retrieves and records the context; no answer, no judge.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { envDynamic } from '@mantle/config';
import { createMigratedScratchDatabase } from '@mantle/db/test-support';
import {
  DATA_SOURCES,
  parseDataset,
  selectHaystacks,
  type DatasetName,
  type Haystack,
} from './datasets';
import type { BenchModels, HaystackResult } from './haystack';
import type { AnswerStyle } from './prompts';
import { summarize, renderReport, estimateRun } from './report';

const SELF = fileURLToPath(import.meta.url);
const CACHE = join(homedir(), '.cache', 'mantle-bench');

/** Defaults: AMB's published answer and judge models (so our number sits
 *  next to theirs), and the brain's shipped worker and embedding defaults. */
export const DEFAULT_MODELS: BenchModels = {
  answer: 'google/gemini-3.1-pro-preview',
  judge: 'google/gemini-2.5-flash-lite',
  extractor: 'google/gemini-3.5-flash-lite',
  embedding: 'openai/text-embedding-3-large',
};

type Args = {
  dataset: DatasetName;
  data: string;
  download: boolean;
  haystacks?: number;
  questions?: number;
  perCategory?: number;
  only?: string[];
  models: BenchModels;
  maxUsd: number;
  concurrency: number;
  extractConcurrency: number;
  out: string;
  resume: boolean;
  keepDb: boolean;
  dryRun: boolean;
  ingestOnly: boolean;
  memoryConfig: Record<string, unknown>;
  answerStyle: AnswerStyle;
  snapshot?: string;
  retrieveOnly: boolean;
};

function parseArgs(argv: string[]): Args {
  const kv = new Map<string, string>();
  const flags = new Set<string>();
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) kv.set(m[1]!, m[2]!);
    else if (a.startsWith('--')) flags.add(a.slice(2));
  }
  const dataset = kv.get('dataset');
  if (dataset !== 'locomo' && dataset !== 'longmemeval')
    throw new Error('--dataset=locomo|longmemeval is required');
  const num = (k: string) => (kv.has(k) ? Number(kv.get(k)) : undefined);
  const resumeDir = kv.get('resume');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    dataset,
    data: kv.get('data') ?? join(CACHE, 'data', DATA_SOURCES[dataset].file),
    download: flags.has('download'),
    haystacks: num('haystacks'),
    questions: num('questions'),
    perCategory: num('per-category'),
    only: kv.get('only')?.split(',').filter(Boolean),
    models: {
      answer: kv.get('answer-model') ?? DEFAULT_MODELS.answer,
      judge: kv.get('judge-model') ?? DEFAULT_MODELS.judge,
      extractor: kv.get('extractor-model') ?? DEFAULT_MODELS.extractor,
      embedding: kv.get('embedding-model') ?? DEFAULT_MODELS.embedding,
    },
    maxUsd: num('max-usd') ?? 1,
    concurrency: num('concurrency') ?? 2,
    extractConcurrency: num('extract-concurrency') ?? 4,
    out: resolve(resumeDir ?? kv.get('out') ?? join(CACHE, 'runs', `${stamp}-${dataset}`)),
    resume: Boolean(resumeDir),
    keepDb: flags.has('keep-db'),
    dryRun: flags.has('dry-run'),
    ingestOnly: flags.has('ingest-only'),
    memoryConfig: parseMemoryConfig(kv.get('memory-config')),
    answerStyle: parseAnswerStyle(kv.get('answer-prompt')),
    snapshot: parseSnapshotName(kv.get('snapshot')),
    retrieveOnly: flags.has('retrieve-only'),
  };
}

/** A snapshot name goes into database names: keep it to [a-z0-9_]. */
function parseSnapshotName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^[a-z0-9_]{1,24}$/.test(raw))
    throw new Error('--snapshot must be 1-24 characters of a-z, 0-9 and _');
  return raw;
}

/** The snapshot database that holds one haystack's ingest. */
const snapshotDbName = (snapshot: string, haystackId: string): string =>
  `mantle_bsnap_${snapshot}_${haystackId.replace(/[^a-zA-Z0-9]/g, '_')}`.slice(0, 63);

async function databaseExists(adminUrl: string, name: string): Promise<boolean> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`select 1 from pg_database where datname = ${name}`;
    return rows.length > 0;
  } finally {
    await sql.end();
  }
}

/** `--memory-config='{"chunk_limit":20}'`: the responder's retrieval limits,
 *  as a real brain's agent carries them (AgentMemoryConfig). */
function parseMemoryConfig(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('--memory-config must be a JSON object');
  return parsed as Record<string, unknown>;
}

function parseAnswerStyle(raw: string | undefined): AnswerStyle {
  if (raw === undefined || raw === 'infer') return 'infer';
  if (raw === 'strict') return 'strict';
  throw new Error('--answer-prompt must be infer or strict');
}

async function loadData(args: Args): Promise<Haystack[]> {
  if (!existsSync(args.data)) {
    if (!args.download)
      throw new Error(
        `${args.data} is missing. Pass --download to fetch it from ${DATA_SOURCES[args.dataset].url} (${DATA_SOURCES[args.dataset].license}), or --data=<path>.`,
      );
    mkdirSync(join(args.data, '..'), { recursive: true });
    const res = await fetch(DATA_SOURCES[args.dataset].url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    writeFileSync(args.data, Buffer.from(await res.arrayBuffer()));
  }
  return parseDataset(args.dataset, JSON.parse(readFileSync(args.data, 'utf8')));
}

/** A database URL on the same server, with another database name. */
function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function adminExec(adminUrl: string, statement: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end();
  }
}

/** Where a child writes its haystack's result: a file, not stdout. A result
 *  with every question's context runs to megabytes, and a pipe write that
 *  large is still in flight when the child exits, so the parent read a cut
 *  line (the first A2 run died on "Unterminated string in JSON"). */
const resultFileFor = (inputFile: string) => inputFile.replace(/\.input\.json$/, '.result.json');

/** Run one haystack in a child process against its own database. The
 *  child's output passes straight through as the run's log. */
function runChild(file: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [...process.execArgv, SELF, `--child=${file}`], {
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('close', (code) => done(code));
  });
}

async function parent(args: Args): Promise<void> {
  const all = await loadData(args);
  const haystacks = selectHaystacks(all, args);
  const estimate = estimateRun(
    args.ingestOnly ? haystacks.map((h) => ({ ...h, questions: [] })) : haystacks,
    args.models,
    { answers: !args.retrieveOnly },
  );
  console.log(
    `[bench] ${args.dataset}: ${haystacks.length} haystacks, ` +
      `${haystacks.reduce((n, h) => n + h.questions.length, 0)} questions, ` +
      `${haystacks.reduce((n, h) => n + h.sessions.length, 0)} sessions`,
  );
  console.log(`[bench] estimate: ${estimate.text}`);
  console.log(`[bench] models: ${JSON.stringify(args.models)}  cap: $${args.maxUsd}`);
  console.log(
    `[bench] memory_config: ${JSON.stringify(args.memoryConfig)}  answer prompt: ${args.answerStyle}` +
      (args.snapshot ? `  snapshot: ${args.snapshot}` : '') +
      (args.retrieveOnly ? '  RETRIEVE ONLY' : ''),
  );
  if (args.dryRun) return;

  const adminUrl = envDynamic('BENCH_PG_ADMIN_URL');
  const apiKey = envDynamic('BENCH_OPENROUTER_API_KEY');
  if (!adminUrl)
    throw new Error('BENCH_PG_ADMIN_URL is required (a throwaway Postgres superuser URL)');
  if (!apiKey) throw new Error('BENCH_OPENROUTER_API_KEY is required');
  if (estimate.usd > args.maxUsd)
    console.warn(
      `[bench] the estimate ($${estimate.usd.toFixed(2)}) is above --max-usd; the run stops at the cap`,
    );

  mkdirSync(join(args.out, 'haystacks'), { recursive: true });
  const done = new Set(
    args.resume
      ? readdirSync(join(args.out, 'haystacks'))
          .filter((f) => f.endsWith('.result.json'))
          .map((f) => f.slice(0, -'.result.json'.length))
      : [],
  );
  const results: HaystackResult[] = [...done].map(
    (id) =>
      JSON.parse(
        readFileSync(join(args.out, 'haystacks', `${id}.result.json`), 'utf8'),
      ) as HaystackResult,
  );
  let spent = results.reduce((n, r) => n + r.total_usd, 0);

  console.log('[bench] migrating the template database…');
  const template = await createMigratedScratchDatabase(adminUrl);
  const masterKey = randomBytes(32).toString('base64');
  const runTag = randomBytes(4).toString('hex');
  const queue = haystacks.filter((h) => !done.has(h.id));
  let i = 0;
  let stoppedForBudget = false;
  // Copies of one template are made one at a time: CREATE DATABASE … TEMPLATE
  // refuses while another session is using the template.
  // A snapshot is copied the same way, under the same lock.
  let createLock: Promise<void> = Promise.resolve();
  // Another run copying the same snapshot holds it for a moment: retry.
  const createDb = (name: string, from: string = template.name) => {
    const next = createLock.then(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await adminExec(adminUrl, `create database "${name}" template "${from}"`);
        } catch (err) {
          if (attempt >= 10 || !/being accessed by other users/.test((err as Error).message))
            throw err;
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    });
    createLock = next.catch(() => {});
    return next;
  };

  const worker = async () => {
    while (i < queue.length) {
      const h = queue[i++]!;
      const perHaystack = estimate.usd / Math.max(1, haystacks.length);
      if (spent + perHaystack > args.maxUsd) {
        stoppedForBudget = true;
        return;
      }
      const dbName = `mantle_bench_${runTag}_${h.id.replace(/[^a-zA-Z0-9]/g, '_')}`.slice(0, 63);
      const file = join(args.out, 'haystacks', `${h.id}.input.json`);
      const started = Date.now();
      let r: HaystackResult;
      // One haystack's failure (a database, a crashed child, an unreadable
      // result) is logged and skipped; it never takes the rest of the run down.
      const childEnv = (o: { ingestOnly: boolean; reuse: boolean }) => ({
        PATH: envDynamic('PATH'),
        HOME: envDynamic('HOME'),
        DATABASE_URL: withDatabase(adminUrl, dbName),
        MANTLE_MASTER_KEY: masterKey,
        BENCH_OPENROUTER_API_KEY: apiKey,
        BENCH_MODELS: JSON.stringify(args.models),
        BENCH_MAX_USD: String(Math.max(0, args.maxUsd - spent)),
        BENCH_EXTRACT_CONCURRENCY: String(args.extractConcurrency),
        BENCH_INGEST_ONLY: o.ingestOnly ? '1' : '',
        BENCH_REUSE_INGEST: o.reuse ? '1' : '',
        BENCH_RETRIEVE_ONLY: args.retrieveOnly ? '1' : '',
        BENCH_MEMORY_CONFIG: JSON.stringify(args.memoryConfig),
        BENCH_ANSWER_STYLE: args.answerStyle,
      });
      try {
        writeFileSync(file, JSON.stringify({ dataset: args.dataset, haystack: h }));
        const snap = args.snapshot ? snapshotDbName(args.snapshot, h.id) : null;
        if (snap && (await databaseExists(adminUrl, snap))) {
          // Reuse: a copy of the snapshot, so the snapshot itself stays as ingested.
          await createDb(dbName, snap);
          const code = await runChild(file, childEnv({ ingestOnly: false, reuse: true }));
          if (code !== 0) throw new Error(`the child exited ${code}`);
          r = JSON.parse(readFileSync(resultFileFor(file), 'utf8')) as HaystackResult;
        } else if (snap && !args.ingestOnly) {
          // Make the snapshot: ingest, copy the untouched result, then answer
          // on it. The first child has exited, so nothing holds the database.
          await createDb(dbName);
          let code = await runChild(file, childEnv({ ingestOnly: true, reuse: false }));
          if (code !== 0) throw new Error(`the ingest child exited ${code}`);
          const ingested = JSON.parse(readFileSync(resultFileFor(file), 'utf8')) as HaystackResult;
          await createDb(snap, dbName);
          console.log(`[bench] ${h.id}: snapshot ${snap} saved`);
          code = await runChild(file, childEnv({ ingestOnly: false, reuse: true }));
          if (code !== 0) throw new Error(`the answer child exited ${code}`);
          const answered = JSON.parse(readFileSync(resultFileFor(file), 'utf8')) as HaystackResult;
          r = {
            ...answered,
            extracted: ingested.extracted,
            extract_failed: ingested.extract_failed,
            ingest_ms: ingested.ingest_ms,
            ingest_loop_delay_ms: ingested.ingest_loop_delay_ms,
            extract_usd: ingested.extract_usd,
            total_usd: ingested.extract_usd + answered.total_usd,
            reused_ingest: false,
          };
        } else {
          await createDb(dbName);
          const code = await runChild(file, childEnv({ ingestOnly: args.ingestOnly, reuse: false }));
          if (code !== 0) throw new Error(`the child exited ${code}`);
          r = JSON.parse(readFileSync(resultFileFor(file), 'utf8')) as HaystackResult;
          if (snap) {
            await createDb(snap, dbName);
            console.log(`[bench] ${h.id}: snapshot ${snap} saved`);
          }
        }
      } catch (err) {
        console.error(
          `[bench] haystack ${h.id} failed: ${(err as Error).message}; see the log above`,
        );
        continue;
      } finally {
        if (!args.keepDb)
          await adminExec(adminUrl, `drop database if exists "${dbName}" with (force)`).catch(
            () => {},
          );
      }
      for (const q of r.questions)
        appendFileSync(
          join(args.out, 'results.jsonl'),
          `${JSON.stringify({ haystack: h.id, ...q })}\n`,
        );
      results.push(r);
      spent += r.total_usd;
      const ok = r.questions.filter((q) => q.correct).length;
      console.log(
        `[bench] ${h.id}: ${ok}/${r.questions.length} correct, ${r.extracted}/${r.sessions} sessions extracted, ` +
          `$${r.total_usd.toFixed(3)} (run total $${spent.toFixed(3)}), ${Math.round((Date.now() - started) / 1000)}s`,
      );
      if (r.stopped_for_budget) stoppedForBudget = true;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
  } finally {
    if (!args.keepDb) await template.drop();
  }

  const summary = summarize(args.dataset, args.models, results, {
    requested: haystacks.length,
    stoppedForBudget,
    memoryConfig: args.memoryConfig,
    answerStyle: args.answerStyle,
    retrieveOnly: args.retrieveOnly,
  });
  writeFileSync(join(args.out, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(args.out, 'report.md'), renderReport(summary));
  console.log(renderReport(summary));
  console.log(`[bench] written to ${args.out}`);
}

async function child(file: string): Promise<void> {
  // Imported here, not at the top: the parent must never open the db pool.
  const { runHaystack } = await import('./haystack');
  const { closeDb } = await import('@mantle/db');
  const input = JSON.parse(readFileSync(file, 'utf8')) as {
    dataset: DatasetName;
    haystack: Haystack;
  };
  // JSON turned the dates into strings.
  const revive = (d: unknown) => (d ? new Date(d as string) : null);
  const haystack: Haystack = {
    ...input.haystack,
    sessions: input.haystack.sessions.map((s) => ({ ...s, date: revive(s.date) })),
    questions: input.haystack.questions.map((q) => ({ ...q, askedAt: revive(q.askedAt) })),
  };
  try {
    const result = await runHaystack({
      dataset: input.dataset,
      haystack,
      models: JSON.parse(envDynamic('BENCH_MODELS') ?? '{}') as BenchModels,
      apiKey: envDynamic('BENCH_OPENROUTER_API_KEY') ?? '',
      maxUsd: Number(envDynamic('BENCH_MAX_USD') ?? 0),
      extractConcurrency: Number(envDynamic('BENCH_EXTRACT_CONCURRENCY') ?? 4),
      ingestOnly: envDynamic('BENCH_INGEST_ONLY') === '1',
      memoryConfig: JSON.parse(envDynamic('BENCH_MEMORY_CONFIG') ?? '{}') as Record<
        string,
        unknown
      >,
      answerStyle: (envDynamic('BENCH_ANSWER_STYLE') ?? 'infer') as AnswerStyle,
      reuseIngest: envDynamic('BENCH_REUSE_INGEST') === '1',
      retrieveOnly: envDynamic('BENCH_RETRIEVE_ONLY') === '1',
    });
    writeFileSync(resultFileFor(file), JSON.stringify(result));
  } finally {
    await closeDb();
  }
}

const childArg = process.argv.find((a) => a.startsWith('--child='));
(childArg ? child(childArg.slice('--child='.length)) : parent(parseArgs(process.argv.slice(2))))
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error(`[bench] ${err.message}`);
    process.exit(1);
  });
