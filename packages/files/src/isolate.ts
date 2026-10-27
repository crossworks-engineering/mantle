/**
 * Document reads that can be made to blow up, run where a blow-up costs a
 * thread and not the server.
 *
 * Every in-process document reader (pdf-parse and pdfjs, mammoth, exceljs,
 * the .pptx, Visio and markup readers, anydoc, the legacy-sheet rebuild, the
 * DWF container, the Project plan reader, the PDF page count, password read
 * and OCR page render, and the picture extractors of all of them) parses
 * untrusted uploads. A
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
 *    {@link withReadWaitLimit});
 *  - a watch on this process's resident memory while reads run, which stops
 *    the read using the most when the memory the heap cap does not see
 *    passes its share (below).
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
 * A read costs its thread's heap ({@link READ_HEAP_MB} at most), its input
 * (the bytes are MOVED into the thread, `transferList`, so the thread holds
 * the one copy made for it: at most the 64 MB upload limit), and memory the
 * heap cap does not see: anydoc is a native (Rust) addon whose own
 * allocations are outside the V8 heap (measured: about 500 MB for the worst
 * document just under its own limits), and inflated zip parts, decoded
 * pictures and canvases are ArrayBuffers or native memory, also outside it
 * (the zip guard, ./zip-guard.ts, holds inflated parts to 128 MB a part and
 * 512 MB a file; pdfjs is opened with a 25-million-pixel picture limit and
 * a page render with a 25-million-pixel canvas, ./pdfjs.ts, so about 100 MB
 * each). So a read is counted as its heap plus {@link NATIVE_HEADROOM_MB},
 * which also covers its input.
 *
 * The process may use what its cgroup allows (`process.constrainedMemory()`,
 * the container's memory cap) or, without one, the machine's memory. Of
 * that, {@link PROCESS_RESERVE_MB} is the process's own (the api container
 * holds about 1.46 GB under normal load), and the rest is shared by reads:
 *
 *   budget           = limit - 1,536 MB
 *   heap a read      = min(768, budget - 512), at least 256 MB
 *   reads at once    = floor(budget / (heap + 512)), 1 to 2;
 *                      1 when no container cap was found
 *
 * In a 3 GB container: budget 1,536 MB, heap 768 MB, one read at a time
 * (768 + 512 = 1,280 MB, so two would not fit), and the process's peak is
 * 1,536 + 1,280 = 2,816 MB, under the 3,072 MB cap. With a cap of 8 GB or
 * more: two. A process that found no cap (a bare machine, a cgroup with no
 * limit) runs one read at a time and says so once in its log: the machine's
 * memory is shared with everything else on it, so it is not a budget.
 *
 * Reads that wait for a slot hold their input in this process (the caller's
 * bytes): at most {@link MAX_WAITING_READS} of them and
 * {@link MAX_WAITING_BYTES} of input together (64 MB uploads: four), a part
 * of the reserve; one more is refused at once (retryable).
 *
 * **The watch on what the heap cap does not see.** While reads run, this
 * process's resident memory is sampled every {@link RSS_SAMPLE_MS} ms. Past
 * what was resident when the first of them started plus each running read's
 * share (heap + headroom + input), or, under a container cap, within
 * {@link RSS_MARGIN_MB} of that cap, the read using the most memory (by its
 * thread's own heap and external memory) is stopped as a
 * {@link DocumentLimitError} (`memory`): a picture decoder or a native
 * allocation that the heap cap cannot stop costs the read, not the process.
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
/** Memory a read uses outside its heap cap: native allocations (anydoc),
 *  ArrayBuffers (inflated parts, decoded pictures, canvases) and its input. */
export const NATIVE_HEADROOM_MB = 512;
/** The most heap one read may have. exceljs rebuilding a 1,000,000-cell
 *  legacy sheet is the largest legitimate user (see ./legacy-sheet.ts). */
export const MAX_READ_HEAP_MB = 768;
/** The least: below it the ordinary readers do not start. */
export const MIN_READ_HEAP_MB = 256;
/** Reads at once, at most, however much memory there is. */
export const MAX_READS_CEILING = 2;

export type MemoryLimit = { bytes: number; capped: boolean };

/** The memory this process may use: its cgroup's cap when it has one
 *  (`capped`), else the machine's. */
export function processMemoryLimit(): MemoryLimit {
  const constrained =
    typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  // A cgroup with no cap reports a huge number (or 0); either way the
  // machine's memory is the real bound, and it is not this process's alone.
  const total = os.totalmem();
  return constrained && constrained > 0 && constrained < total
    ? { bytes: constrained, capped: true }
    : { bytes: total, capped: false };
}

export type ReadBudget = { limitMb: number; heapMb: number; concurrency: number };

/** Heap a read and reads at once, from the memory the process may use (see
 *  the module note for the numbers). Without a container cap, one read at a
 *  time. */
export function readBudget(limitBytes?: number, capped = true): ReadBudget {
  if (limitBytes === undefined) {
    const found = processMemoryLimit();
    limitBytes = found.bytes;
    capped = found.capped;
  }
  const limitMb = Math.floor(limitBytes / (1024 * 1024));
  const budget = Math.max(0, limitMb - PROCESS_RESERVE_MB);
  const heapMb = Math.max(
    MIN_READ_HEAP_MB,
    Math.min(MAX_READ_HEAP_MB, budget - NATIVE_HEADROOM_MB),
  );
  const fits = Math.floor(budget / (heapMb + NATIVE_HEADROOM_MB));
  const concurrency = capped ? Math.max(1, Math.min(MAX_READS_CEILING, fits)) : 1;
  return { limitMb, heapMb, concurrency };
}

const LIMIT = processMemoryLimit();
const BUDGET = readBudget(LIMIT.bytes, LIMIT.capped);

/** Old-generation heap a read may use, from {@link readBudget}. */
export const READ_HEAP_MB = BUDGET.heapMb;

/** Reads at once in one process, from {@link readBudget}; the rest wait. */
export const MAX_CONCURRENT_READS = BUDGET.concurrency;

/** Reads that may wait for a slot; one more is refused at once (retryable). */
export const MAX_WAITING_READS = 16;

/** Input bytes that may wait for a slot together; a read that would pass it
 *  is refused at once (retryable). */
export const MAX_WAITING_BYTES = 256 * 1024 * 1024;

/** How often resident memory is sampled while reads run. */
export const RSS_SAMPLE_MS = 20;
/** Under a container cap, a read is stopped when the process comes this
 *  close to the cap. */
export const RSS_MARGIN_MB = 160;

/** How long a read may wait for a slot by default (the extractor's reads):
 *  longer than one read's whole time limit, so a slow read ahead of it does
 *  not fail it. A chat turn waits less ({@link withReadWaitLimit}). */
export const READ_WAIT_MS = 2 * READ_TIMEOUT_MS;

let budgetLogged = false;
/** Once per process: say how reads are budgeted, and say it loudly when no
 *  container cap was found. */
function logBudgetOnce(): void {
  if (budgetLogged) return;
  budgetLogged = true;
  const line =
    `document reads: ${MAX_CONCURRENT_READS} at once, ${READ_HEAP_MB} MB heap each, ` +
    `from ${BUDGET.limitMb} MB`;
  // Imported here, not at the top: every importer of @mantle/files would
  // otherwise load the tracing store with it.
  void import('@mantle/tracing')
    .then(({ log }) => {
      if (LIMIT.capped) log('files').info(`${line} (container cap)`);
      else
        log('files').warn(
          `${line} of machine memory: no container memory cap found, so one read at a time`,
        );
    })
    .catch(() => {});
}

const waitLimit = new AsyncLocalStorage<number>();

/** Run `fn` with the reads it starts waiting at most `ms` for a slot: a
 *  chat turn with an attachment answers in time, saying the file could not
 *  be read just now, rather than queueing behind a backlog of uploads. */
export function withReadWaitLimit<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return waitLimit.run(ms, fn);
}

let active = 0;
type Waiter = { grant: () => void; bytes: number };
const waiting: Waiter[] = [];
let waitingBytes = 0;

/** Take a read slot; resolves with the function that gives it back (once).
 *  `bytes` is the read's input, counted while it waits. */
function acquireSlot(waitMs: number, bytes: number): Promise<() => void> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    active--;
    const next = waiting.shift();
    if (next) {
      waitingBytes -= next.bytes;
      next.grant();
    }
  };
  if (active < MAX_CONCURRENT_READS) {
    active++;
    return Promise.resolve(release);
  }
  if (waiting.length >= MAX_WAITING_READS || waitingBytes + bytes > MAX_WAITING_BYTES) {
    return Promise.reject(
      new DocumentReadRetryableError(
        `The server is reading ${active + waiting.length} documents already; this one will be read on a retry.`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      bytes,
      grant: () => {
        clearTimeout(timer);
        active++;
        resolve(release);
      },
    };
    const timer = setTimeout(() => {
      const at = waiting.indexOf(waiter);
      if (at !== -1) {
        waiting.splice(at, 1);
        waitingBytes -= waiter.bytes;
      }
      reject(
        new DocumentReadRetryableError(
          `Waited ${Math.round(waitMs / 1000)} s for the server to finish other documents; this one will be read on a retry.`,
        ),
      );
    }, waitMs);
    timer.unref?.();
    waiting.push(waiter);
    waitingBytes += bytes;
  });
}

/** Reads in flight and waiting, for tests and the status line. */
export function readSlots(): { active: number; waiting: number; waitingBytes: number } {
  return { active, waiting: waiting.length, waitingBytes };
}

// ─── the watch on memory the heap cap does not see ────────────────────

type Running = { worker: Worker; allowance: number; stop: (err: Error) => void };
const running = new Set<Running>();
let rssBaseline = 0;
let watchTimer: ReturnType<typeof setInterval> | null = null;
let choosing = false;

/** The read using the most memory: its thread's heap and external memory
 *  (ArrayBuffers, decoded pictures), asked of each running thread. The most
 *  recent when the threads cannot say. */
async function heaviest(): Promise<Running | undefined> {
  const reads = [...running];
  if (reads.length <= 1) return reads[0];
  const sizes = await Promise.all(
    reads.map((r) =>
      Promise.race([
        r.worker
          .getHeapStatistics()
          .then(
            (s) => s.used_heap_size + ((s as { external_memory?: number }).external_memory ?? 0),
          ),
        new Promise<number>((resolve) => setTimeout(() => resolve(-1), 250)),
      ]).catch(() => -1),
    ),
  );
  let best = reads.length - 1;
  for (let i = 0; i < reads.length; i++) if (sizes[i]! > sizes[best]!) best = i;
  return reads[best];
}

function sampleMemory(): void {
  if (choosing || running.size === 0) return;
  const rss = process.memoryUsage.rss();
  let allowed = rssBaseline;
  for (const r of running) allowed += r.allowance;
  const nearCap = LIMIT.capped && rss > LIMIT.bytes - RSS_MARGIN_MB * 1024 * 1024;
  if (rss <= allowed && !nearCap) return;
  choosing = true;
  void heaviest()
    .then((victim) => {
      if (!victim || !running.has(victim)) return;
      const mb = Math.round(rss / (1024 * 1024));
      victim.stop(
        new DocumentLimitError(
          'memory',
          `Reading the file needed more memory than a document read may use (the server reached ${mb.toLocaleString('en-US')} MB), and was stopped.`,
        ),
      );
    })
    .finally(() => {
      choosing = false;
    });
}

function watch(r: Running): () => void {
  if (running.size === 0) rssBaseline = process.memoryUsage.rss();
  running.add(r);
  if (!watchTimer) {
    watchTimer = setInterval(sampleMemory, RSS_SAMPLE_MS);
    watchTimer.unref?.();
  }
  return () => {
    running.delete(r);
    if (running.size === 0 && watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  };
}

// ─── time-outs ────────────────────────────────────────────────────────

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

// ─── crossing the thread ──────────────────────────────────────────────

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

/** The input bytes of a read's arguments (strings count two bytes a
 *  character). */
function inputBytes(args: readonly unknown[]): number {
  let n = 0;
  for (const a of args) {
    if (a instanceof Uint8Array) n += a.byteLength;
    else if (typeof a === 'string') n += a.length * 2;
  }
  return n;
}

/** The arguments as the thread gets them: each byte array copied ONCE into
 *  an ArrayBuffer of its own, which is then moved (`transferList`), not
 *  copied again by the structured clone. The caller's bytes stay usable. */
function forTransfer(args: readonly unknown[]): { args: unknown[]; transfer: ArrayBuffer[] } {
  const transfer: ArrayBuffer[] = [];
  const out = args.map((a) => {
    if (!(a instanceof Uint8Array)) return a;
    const copy = new Uint8Array(a.byteLength);
    copy.set(a);
    transfer.push(copy.buffer);
    return copy;
  });
  return { args: out, transfer };
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
  logBudgetOnce();
  const timeoutMs = limits.timeoutMs ?? READ_TIMEOUT_MS;
  const heapMb = limits.heapMb ?? READ_HEAP_MB;
  const waitMs = limits.waitMs ?? waitLimit.getStore() ?? READ_WAIT_MS;
  const bytes = inputBytes(args);
  const release = await acquireSlot(waitMs, bytes);
  return new Promise<JobResult<K>>((resolve, reject) => {
    let worker: Worker;
    try {
      const moved = forTransfer(args);
      worker = new Worker(new URL('./isolate-worker.ts', import.meta.url), {
        workerData: { kind: 'mantle-parse', job, args: moved.args },
        transferList: moved.transfer,
        resourceLimits: { maxOldGenerationSizeMb: heapMb },
      });
    } catch (err) {
      release();
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const unwatch = watch({
      worker,
      allowance: (heapMb + NATIVE_HEADROOM_MB) * 1024 * 1024 + bytes,
      stop: (err) => finish(() => reject(err)),
    });
    // The slot is the thread's, not the answer's: it is free once the
    // thread has gone, so a terminated read still running cannot overlap
    // the next one.
    worker.once('exit', () => {
      unwatch();
      release();
    });
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
