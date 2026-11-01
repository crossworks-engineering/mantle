/**
 * code_search's matcher: `file:line: text` hits over a tree, capped. A
 * plain pattern is a substring test on the main thread. A regex is the
 * caller's own, and a backtracking one can run for minutes on one line, so
 * it runs in a worker thread that is ended after REGEX_TIMEOUT_MS: the
 * process never waits on it.
 */
import { Worker } from 'node:worker_threads';

export const REGEX_TIMEOUT_MS = 3000;
/** Regex searches running at once in this process; more wait their turn. */
export const REGEX_WORKERS_MAX = 2;
/** Searches waiting for a worker; past this a search is refused. */
const REGEX_QUEUE_MAX = 16;
/** A hit's line is cut to this many characters. */
export const HIT_TEXT_MAX = 200;

export type SearchHits = {
  /** `path:line: text`, in path then line order, at most the cap. */
  hits: string[];
  /** Every hit, past the cap too. */
  total: number;
  files: number;
};

type Job = {
  files: [string, string][];
  pattern: string;
  regex: boolean;
  ignoreCase: boolean;
  cap: number;
  textMax: number;
};

/** The matcher, as one function the worker also runs (its source is sent
 *  as the worker's code: no file to find under a bundler). Plain JS only. */
function runSearch(job: Job): SearchHits {
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
      const hit = re
        ? re.test(line)
        : (job.ignoreCase ? line.toLowerCase() : line).includes(needle);
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
      return await runInWorker(job);
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
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const timer = setTimeout(async () => {
      // The slot is freed once the worker is gone, never before.
      await worker.terminate().catch(() => undefined);
      resolve({
        error: `the regex ran past ${REGEX_TIMEOUT_MS / 1000}s and was stopped (a pattern like (a+)+ backtracks without end). Use a simpler pattern, narrow it with glob, or search the plain text with regex false`,
      });
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
