/**
 * code_search's matcher: `file:line: text` hits over a tree, capped. A
 * plain pattern is a substring test on the main thread. A regex is the
 * caller's own, and a backtracking one can run for minutes on one line, so
 * it runs in a worker thread that is ended after REGEX_TIMEOUT_MS: the
 * process never waits on it.
 */
import { Worker } from 'node:worker_threads';

export const REGEX_TIMEOUT_MS = 3000;
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
      const line = lines[i]!;
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
  opts: { regex: boolean; ignoreCase: boolean; cap: number },
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
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SRC, { eval: true, workerData: job });
    const timer = setTimeout(() => {
      void worker.terminate();
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
      resolve({ error: `the search failed: ${err.message}` });
    });
  });
}
