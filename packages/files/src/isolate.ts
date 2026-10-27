/**
 * Document reads that can be made to blow up, run where a blow-up costs a
 * thread and not the server.
 *
 * Every in-process document reader (pdf-parse and pdfjs, mammoth, exceljs,
 * the .pptx, Visio and markup readers, anydoc, the legacy-sheet rebuild, and
 * the picture extractors of all of them) parses untrusted uploads. A
 * decompression bomb, a sheet whose two cells span millions of empty ones or
 * a scan that turns quadratic used to run on the web or api process's own
 * heap and event loop: tens of seconds frozen, more than a gigabyte
 * resident, and an out-of-memory crash takes every request with it. Here
 * each read runs in a worker thread of its own with:
 *
 *  - a heap cap (`resourceLimits`): past it the thread dies with
 *    ERR_WORKER_OUT_OF_MEMORY and the server carries on;
 *  - a wall-clock limit: past it the thread is terminated;
 *  - a bound on reads at once per process, sized from the memory the
 *    process may use (below), so a burst of uploads queues instead of
 *    multiplying the memory;
 *  - a bounded wait: at most {@link MAX_WAITING_READS} reads queue, each for
 *    at most its wait limit ({@link READ_WAIT_MS}, or less for a chat turn,
 *    {@link withReadWaitLimit}).
 *
 * A limit the DOCUMENT hit ends as a {@link DocumentLimitError}, which the
 * extractor records as a terminal skip with the reason (no retry until the
 * file changes). Waiting too long, a full queue, and a FIRST time-out end as
 * a {@link DocumentReadRetryableError}: the job fails and is retried, because
 * a loaded box can be slow once; the same bytes timing out a second time is
 * the document, and that one is terminal. A failure that is not about the
 * document (the thread could not start) stays a plain error.
 *
 * ## The memory budget
 *
 * A read costs its thread's heap ({@link READ_HEAP_MB} at most) plus memory
 * the heap cap does not see: anydoc is a native (Rust) addon whose own
 * allocations are outside the V8 heap (measured: about 500 MB for the worst
 * document just under its own limits), and inflated zip parts and decoded
 * pictures are ArrayBuffers, also outside it (the zip guard, ./zip-guard.ts,
 * holds those to 128 MB a part and 512 MB a file). So a read is counted as
 * its heap plus {@link NATIVE_HEADROOM_MB}.
 *
 * The process may use what its cgroup allows (`process.constrainedMemory()`,
 * the container's memory cap) or, without one, the machine's memory. Of
 * that, {@link PROCESS_RESERVE_MB} is the process's own (the api container
 * holds about 1.46 GB under normal load), and the rest is shared by reads:
 *
 *   heap a read      = min(768, budget - 512), at least 256 MB
 *   reads at once    = floor(budget / (heap + 512)), 1 to 2
 *
 * In a 3 GB container: budget 1,536 MB, heap 768 MB, one read at a time
 * (768 + 512 = 1,280 MB, so two would not fit). With 8 GB or more: two.
 *
 * **What the limits do not stop.** anydoc's native work runs on a native
 * thread that terminating the worker does not stop; it is bounded by its own
 * fixed safety limits (2 million XML nodes per part, decompression and
 * asset totals, 4 million grid slots), which end in its `resourceLimit`
 * error, and a legacy sheet is measured and capped before anydoc sees it
 * (./sheet-extent.ts). A read's slot is freed when its thread has exited,
 * not when its answer arrives.
 *
 * One fresh thread per read: a few hundred milliseconds of start-up against
 * reads that are rare (an upload, an attachment) and a heap that is always
 * clean.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { DocumentLimitError, DocumentReadRetryableError } from './document-limit';
import type { JobArgs, JobName, JobResult } from './isolate-jobs';

/** A read that takes longer is stopped. Generous: a normal document reads
 *  in milliseconds, the worst bomb anydoc lets through in about 6 s. */
export const READ_TIMEOUT_MS = 60_000;

/** The process's own memory, not lent to reads (the api's normal load is
 *  about 1.46 GB). */
export const PROCESS_RESERVE_MB = 1536;
/** Memory a read uses outside its heap cap: native allocations (anydoc) and
 *  ArrayBuffers (inflated parts, decoded pictures). */
export const NATIVE_HEADROOM_MB = 512;
/** The most heap one read may have. exceljs rebuilding a 1,000,000-cell
 *  legacy sheet is the largest legitimate user (see ./legacy-sheet.ts). */
export const MAX_READ_HEAP_MB = 768;
/** The least: below it the ordinary readers do not start. */
export const MIN_READ_HEAP_MB = 256;
/** Reads at once, at most, however much memory there is. */
export const MAX_READS_CEILING = 2;

/** The memory this process may use: its cgroup's cap when it has one, else
 *  the machine's. */
export function processMemoryLimitBytes(): number {
  const constrained =
    typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  // A cgroup with no cap reports a huge number (or 0); either way the
  // machine's memory is the real bound.
  const total = os.totalmem();
  return constrained && constrained > 0 && constrained < total ? constrained : total;
}

export type ReadBudget = { limitMb: number; heapMb: number; concurrency: number };

/** Heap a read and reads at once, from the memory the process may use (see
 *  the module note for the numbers). */
export function readBudget(limitBytes = processMemoryLimitBytes()): ReadBudget {
  const limitMb = Math.floor(limitBytes / (1024 * 1024));
  const budget = Math.max(0, limitMb - PROCESS_RESERVE_MB);
  const heapMb = Math.max(
    MIN_READ_HEAP_MB,
    Math.min(MAX_READ_HEAP_MB, budget - NATIVE_HEADROOM_MB),
  );
  const concurrency = Math.max(
    1,
    Math.min(MAX_READS_CEILING, Math.floor(budget / (heapMb + NATIVE_HEADROOM_MB))),
  );
  return { limitMb, heapMb, concurrency };
}

const BUDGET = readBudget();

/** Old-generation heap a read may use, from {@link readBudget}. */
export const READ_HEAP_MB = BUDGET.heapMb;

/** Reads at once in one process, from {@link readBudget}; the rest wait. */
export const MAX_CONCURRENT_READS = BUDGET.concurrency;

/** Reads that may wait for a slot; one more is refused at once (retryable). */
export const MAX_WAITING_READS = 16;

/** How long a read may wait for a slot by default (the extractor's reads):
 *  longer than one read's whole time limit, so a slow read ahead of it does
 *  not fail it. A chat turn waits less ({@link withReadWaitLimit}). */
export const READ_WAIT_MS = 2 * READ_TIMEOUT_MS;

const waitLimit = new AsyncLocalStorage<number>();

/** Run `fn` with the reads it starts waiting at most `ms` for a slot: a
 *  chat turn with an attachment answers in time, saying the file could not
 *  be read just now, rather than queueing behind a backlog of uploads. */
export function withReadWaitLimit<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return waitLimit.run(ms, fn);
}

let active = 0;
const waiting: Array<() => void> = [];

/** Take a read slot; resolves with the function that gives it back (once). */
function acquireSlot(waitMs: number): Promise<() => void> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    active--;
    waiting.shift()?.();
  };
  if (active < MAX_CONCURRENT_READS) {
    active++;
    return Promise.resolve(release);
  }
  if (waiting.length >= MAX_WAITING_READS) {
    return Promise.reject(
      new DocumentReadRetryableError(
        `The server is reading ${active + waiting.length} documents already; this one will be read on a retry.`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const grant = () => {
      clearTimeout(timer);
      active++;
      resolve(release);
    };
    const timer = setTimeout(() => {
      const at = waiting.indexOf(grant);
      if (at !== -1) waiting.splice(at, 1);
      reject(
        new DocumentReadRetryableError(
          `Waited ${Math.round(waitMs / 1000)} s for the server to finish other documents; this one will be read on a retry.`,
        ),
      );
    }, waitMs);
    timer.unref?.();
    waiting.push(grant);
  });
}

/** Reads in flight and waiting, for tests and the status line. */
export function readSlots(): { active: number; waiting: number } {
  return { active, waiting: waiting.length };
}

/** Bytes that timed out once, by a key of their content: a second time-out
 *  of the same bytes is terminal. Bounded; the oldest key goes first. */
const timedOut = new Map<string, number>();
const TIMED_OUT_KEEP = 256;

/** A key for the document a read is given: its length and a hash of its
 *  first and last 256 KB (the whole of a small one). Cheap on the main
 *  thread; two different documents sharing one only makes the second one's
 *  first time-out terminal. */
function documentKey(job: string, args: readonly unknown[]): string | null {
  const doc = args.find(
    (a): a is Uint8Array | string => a instanceof Uint8Array || typeof a === 'string',
  );
  if (doc === undefined) return null;
  const hash = createHash('sha256').update(job);
  const SPAN = 256 * 1024;
  if (typeof doc === 'string') {
    hash.update(String(doc.length));
    hash.update(doc.length <= 2 * SPAN ? doc : doc.slice(0, SPAN) + doc.slice(-SPAN));
  } else {
    hash.update(String(doc.byteLength));
    if (doc.byteLength <= 2 * SPAN) hash.update(doc);
    else hash.update(doc.subarray(0, SPAN)).update(doc.subarray(doc.byteLength - SPAN));
  }
  return hash.digest('hex');
}

/** The error for a read past its time limit: retryable the first time for
 *  these bytes, terminal the second. */
function timeoutError(key: string | null, timeoutMs: number): Error {
  const took = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
  if (key !== null && !timedOut.has(key)) {
    timedOut.set(key, Date.now());
    while (timedOut.size > TIMED_OUT_KEEP) {
      const oldest = timedOut.keys().next().value;
      if (oldest === undefined) break;
      timedOut.delete(oldest);
    }
    return new DocumentReadRetryableError(
      `Reading the file took longer than ${took} and was stopped; it will be tried once more.`,
    );
  }
  if (key !== null) timedOut.delete(key);
  return new DocumentLimitError(
    'timeout',
    `Reading the file took longer than ${took}, twice, and was stopped.`,
  );
}

/** A Buffer crosses a thread as a plain Uint8Array; make it a Buffer again,
 *  in arrays and plain objects a few levels down. */
function revive(value: unknown, depth = 0): unknown {
  if (value instanceof Uint8Array) {
    return Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => revive(v, depth + 1));
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = revive(v, depth + 1);
  return out;
}

type WorkerError = { name: string; message: string; code?: unknown; reason?: unknown };
type Reply = { ok: true; result: unknown } | { ok: false; error: WorkerError };

/** The error a worker posted, rebuilt: a DocumentLimitError keeps its
 *  reason, anything else keeps its message and `code` (anydoc's
 *  `malformed`, `encrypted`...). */
function rebuild(e: WorkerError): Error {
  if (e.name === 'DocumentLimitError' && typeof e.reason === 'string') {
    return new DocumentLimitError(e.reason as DocumentLimitError['reason'], e.message);
  }
  if (e.name === 'DocumentReadRetryableError') return new DocumentReadRetryableError(e.message);
  const err = new Error(e.message);
  if (e.name && e.name !== 'Error') err.name = e.name;
  if (e.code !== undefined) (err as Error & { code?: unknown }).code = e.code;
  return err;
}

/** True inside a read's own thread, where a nested read just runs. */
function inReadThread(): boolean {
  return !isMainThread && (workerData as { kind?: unknown } | null)?.kind === 'mantle-parse';
}

export type ReadLimits = { timeoutMs?: number; heapMb?: number; waitMs?: number };

/**
 * Run one read (a job in ./isolate-jobs.ts) in its own thread under the
 * limits above. Resolves with its result; rejects with the reader's own
 * error, a {@link DocumentLimitError} when a limit stopped it, or a
 * {@link DocumentReadRetryableError} when it could not run in time.
 */
export async function runIsolated<K extends JobName>(
  job: K,
  args: JobArgs<K>,
  limits: ReadLimits = {},
): Promise<JobResult<K>> {
  if (inReadThread()) {
    const { runJob } = await import('./isolate-jobs');
    return (await runJob(job, args)) as JobResult<K>;
  }
  const timeoutMs = limits.timeoutMs ?? READ_TIMEOUT_MS;
  const heapMb = limits.heapMb ?? READ_HEAP_MB;
  const waitMs = limits.waitMs ?? waitLimit.getStore() ?? READ_WAIT_MS;
  const release = await acquireSlot(waitMs);
  return new Promise<JobResult<K>>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./isolate-worker.ts', import.meta.url), {
        workerData: { kind: 'mantle-parse', job, args },
        resourceLimits: { maxOldGenerationSizeMb: heapMb },
      });
    } catch (err) {
      release();
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // The slot is the thread's, not the answer's: it is free once the
    // thread has gone, so a terminated read still running cannot overlap
    // the next one.
    worker.once('exit', release);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(timeoutError(documentKey(job, args), timeoutMs))),
      timeoutMs,
    );
    worker.once('message', (m: Reply) =>
      finish(() => (m.ok ? resolve(revive(m.result) as JobResult<K>) : reject(rebuild(m.error)))),
    );
    worker.once('error', (err: Error & { code?: string }) =>
      finish(() =>
        reject(
          err.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? new DocumentLimitError(
                'memory',
                `Reading the file needed more than the ${heapMb} MB a document read may use, and was stopped.`,
              )
            : err,
        ),
      ),
    );
    worker.once('exit', (code) =>
      finish(() =>
        reject(new Error(`the document reader stopped without an answer (exit ${code})`)),
      ),
    );
  });
}
