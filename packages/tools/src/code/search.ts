/**
 * code_search's matcher: `file:line: text` hits over a tree, capped. A
 * plain pattern is a substring test on the main thread. A regex is the
 * caller's own, and a backtracking one can run for minutes on one line, so
 * it runs in a worker thread that is ended after REGEX_TIMEOUT_MS: the
 * process never waits on it. Bun ignores a worker's memory limit, so there
 * it runs in a process of its own under a kernel limit (as draw-png.ts).
 */
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { killWithParent } from '@mantle/std/kill-with-parent';
import { runtimeFlags, withMemoryLimit } from '@mantle/std/self-spawn';

export const REGEX_TIMEOUT_MS = 3000;
/** Regex searches running at once in this process; more wait their turn. */
export const REGEX_WORKERS_MAX = 2;
/** Searches waiting for a worker; past this a search is refused. */
const REGEX_QUEUE_MAX = 16;
/** The JS heap of a regex worker (Node). */
const REGEX_WORKER_HEAP_MB = 256;
/** The kernel limit on a regex process (Bun): the worker's heap, plus the
 *  about 300 MB Bun needs to start. */
export const REGEX_CHILD_MEMORY_MB = 640;
/** Bun's regex engine gives up on a hard pattern and answers no match, even
 *  where a match exists, with no error. It gives up after a count of steps,
 *  not a time: about 0.3 s on a fast machine, 0.6 s on a workstation. So on
 *  Bun a line this slow that did not match fails the search: no answer beats a
 *  wrong one. A match is never a give up, so it stands. */
export const BUN_LINE_MS = 100;
/** What a search that hit that limit says, before the file and line. */
export const TOO_HARD =
  'the regex is too hard for this runtime, which gives up on it and can miss a match (a pattern like (a+)+ backtracks without end). Use a simpler pattern, narrow it with glob, or search the plain text with regex false';
/** A hit's line is cut to this many characters. */
export const HIT_TEXT_MAX = 200;

export type SearchHits = {
  /** `path:line: text`, in path then line order, at most the cap. */
  hits: string[];
  /** Every hit, past the cap too. */
  total: number;
  files: number;
};

export type Job = {
  files: [string, string][];
  pattern: string;
  regex: boolean;
  ignoreCase: boolean;
  cap: number;
  textMax: number;
  /** Bun only: the longest one line may take, and what that failure says. */
  lineLimit?: { ms: number; error: string };
};

/** The matcher, as one function the worker also runs (its source is sent
 *  as the worker's code: no file to find under a bundler). Plain JS only. */
export function runSearch(job: Job): SearchHits {
  const re = job.regex ? new RegExp(job.pattern, job.ignoreCase ? 'i' : '') : null;
  const needle = job.ignoreCase ? job.pattern.toLowerCase() : job.pattern;
  const hits: string[] = [];
  let total = 0;
  let files = 0;
  for (const [path, text] of job.files) {
    const lines = text.split('\n');
    let inFile = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const started = job.lineLimit ? performance.now() : 0;
      const hit = re
        ? re.test(line)
        : (job.ignoreCase ? line.toLowerCase() : line).includes(needle);
      if (!hit && job.lineLimit && performance.now() - started >= job.lineLimit.ms) {
        throw new Error(`${job.lineLimit.error} (at ${path}:${i + 1})`);
      }
      if (!hit) continue;
      total++;
      inFile = true;
      if (hits.length < job.cap) {
        const shown = line.length > job.textMax ? line.slice(0, job.textMax) + '…' : line;
        hits.push(`${path}:${i + 1}: ${shown}`);
      }
    }
    if (inFile) files++;
  }
  return { hits, total, files };
}

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
${runSearch.toString()}
try { parentPort.postMessage({ ok: true, res: runSearch(workerData) }); }
catch (e) { parentPort.postMessage({ ok: false, error: String(e && e.message || e) }); }
`;

/** The same matcher as a process (Bun): the job on stdin, the answer on
 *  stdout, each one JSON text. Globals only, no require. */
const CHILD_SRC = `
${runSearch.toString()}
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  let out;
  try { out = { ok: true, res: runSearch(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }; }
  catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
  process.stdout.write(JSON.stringify(out));
});
`;

/** Search `files` (path order) for `pattern`. An invalid regex, or one that
 *  runs past the timeout, is an `{ error }` the caller can act on. */
export async function searchFiles(
  files: Record<string, string>,
  pattern: string,
  opts: { regex: boolean; ignoreCase: boolean; cap: number; caller?: string },
): Promise<SearchHits | { error: string }> {
  const job: Job = {
    files: Object.keys(files)
      .sort()
      .map((p) => [p, files[p]!]),
    pattern,
    regex: opts.regex,
    ignoreCase: opts.ignoreCase,
    cap: opts.cap,
    textMax: HIT_TEXT_MAX,
  };
  if (!opts.regex) return runSearch(job);
  try {
    new RegExp(pattern);
  } catch (err) {
    return {
      error: `pattern is not a valid regular expression (${(err as Error).message}). Fix it, or search the plain text with regex false`,
    };
  }
  // One running regex search per caller: one caller cannot take every slot.
  const caller = opts.caller ?? '';
  if (byCaller.has(caller)) {
    return {
      error:
        'a regex search of yours is still running: wait for it, or search the plain text with regex false',
    };
  }
  byCaller.add(caller);
  try {
    if (!(await takeWorker())) {
      return {
        error:
          'too many regex searches are running on this brain: try again in a few seconds, or search the plain text with regex false',
      };
    }
    try {
      return await (process.versions.bun ? runInChild : runInWorker)(job);
    } finally {
      releaseWorker();
    }
  } finally {
    byCaller.delete(caller);
  }
}

/** The callers with a regex search running or waiting. */
const byCaller = new Set<string>();

let running = 0;
const waiting: (() => void)[] = [];

/** A worker slot: at once when one is free, else in line (false when the
 *  line is full). */
async function takeWorker(): Promise<boolean> {
  if (running < REGEX_WORKERS_MAX) {
    running++;
    return true;
  }
  if (waiting.length >= REGEX_QUEUE_MAX) return false;
  await new Promise<void>((go) => waiting.push(go));
  return true;
}

function releaseWorker(): void {
  const go = waiting.shift();
  if (go) go();
  else running--;
}

/** One search in a fresh worker, ended at the timeout or when it answers. */
function runInWorker(job: Job): Promise<SearchHits | { error: string }> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: job,
      resourceLimits: { maxOldGenerationSizeMb: REGEX_WORKER_HEAP_MB },
    });
    const timer = setTimeout(async () => {
      // The slot is freed once the worker is gone, never before.
      await worker.terminate().catch(() => undefined);
      resolve({ error: TIMED_OUT });
    }, REGEX_TIMEOUT_MS);
    worker.once('message', (m: { ok: true; res: SearchHits } | { ok: false; error: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(m.ok ? m.res : { error: `the search failed: ${m.error}` });
    });
    worker.once('error', (err: Error) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve({ error: `the search failed: ${err.message}` });
    });
  });
}

const TIMED_OUT = `the regex ran past ${REGEX_TIMEOUT_MS / 1000}s and was stopped (a pattern like (a+)+ backtracks without end). Use a simpler pattern, narrow it with glob, or search the plain text with regex false`;

/** One search in a fresh process (Bun), with no env and under a kernel
 *  memory limit, killed at the timeout. Its slot is freed once it is gone. */
function runInChild(job: Job): Promise<SearchHits | { error: string }> {
  const { command, args } = withMemoryLimit(REGEX_CHILD_MEMORY_MB, {
    command: process.execPath,
    args: [...runtimeFlags(), '--input-type=commonjs', '-e', CHILD_SRC],
  });
  return new Promise((resolve) => {
    let why: string | null = null;
    const out: Buffer[] = [];
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], env: {} });
    killWithParent(proc);
    const timer = setTimeout(() => {
      why = TIMED_OUT;
      proc.kill('SIGKILL');
    }, REGEX_TIMEOUT_MS);
    // on, not once: a failed spawn and a failed write can each raise one.
    proc.on('error', (err) => {
      why ??= `the search failed: ${err.message}`;
      proc.kill('SIGKILL');
    });
    proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    // A process that died early closes its stdin: 'close' below says so.
    proc.stdin.on('error', () => {});
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (why) return resolve({ error: why });
      if (code !== 0) return resolve({ error: `the search stopped (${signal ?? `exit ${code}`})` });
      try {
        const m = JSON.parse(Buffer.concat(out).toString('utf8')) as
          { ok: true; res: SearchHits } | { ok: false; error: string };
        if (m.ok) resolve(m.res);
        else
          resolve({
            error: m.error.startsWith(TOO_HARD) ? m.error : `the search failed: ${m.error}`,
          });
      } catch {
        resolve({ error: 'the search gave no answer' });
      }
    });
    proc.stdin.end(JSON.stringify({ ...job, lineLimit: { ms: BUN_LINE_MS, error: TOO_HARD } }));
  });
}
