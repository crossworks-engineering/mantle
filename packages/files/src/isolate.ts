/**
 * Document reads that can be made to blow up, run where a blow-up costs a
 * thread and not the server.
 *
 * The readers anydoc, the legacy-sheet rebuild, the Visio reader, the markup
 * reader and anydoc's pictures parse untrusted uploads in-process. A
 * decompression bomb or a sheet whose two cells span millions of empty ones
 * used to run on the web or api process's own heap and event loop: tens of
 * seconds frozen, more than a gigabyte resident, and an out-of-memory crash
 * takes every request with it. Here each read runs in a worker thread of its
 * own with:
 *
 *  - a heap cap (`resourceLimits`): past it the thread dies with
 *    ERR_WORKER_OUT_OF_MEMORY and the server carries on;
 *  - a wall-clock limit: past it the thread is terminated;
 *  - a bound on reads at once per process, so a burst of uploads queues
 *    instead of multiplying the memory.
 *
 * Both limits end as a {@link DocumentLimitError}, which the extractor
 * records as a terminal skip with the reason (no retry until the file
 * changes). A failure that is not about the document (the thread could not
 * start) stays a plain error, so the job is retried.
 *
 * **What the heap cap does not cover.** anydoc is a native (Rust) addon: its
 * own allocations are outside the V8 heap and its work runs on a native
 * thread that terminating the worker does not stop. Those are bounded by
 * anydoc's fixed safety limits (2 million XML nodes per part, decompression
 * and asset totals), which end in its `resourceLimit` error; measured, the
 * worst document just under them holds about 500 MB resident for about 6 s.
 * The bound on reads at once is what keeps several of those from stacking,
 * and it also keeps anydoc's native work from taking more than
 * {@link MAX_CONCURRENT_READS} threads.
 *
 * One fresh thread per read: a few hundred milliseconds of start-up against
 * reads that are rare (an upload, an attachment) and a heap that is always
 * clean.
 */

import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { DocumentLimitError } from './document-limit';
import type { JobArgs, JobName, JobResult } from './isolate-jobs';

/** A read that takes longer is stopped. Generous: a normal document reads
 *  in milliseconds, the worst bomb anydoc lets through in about 6 s. */
export const READ_TIMEOUT_MS = 60_000;

/** Old-generation heap a read may use. exceljs rebuilding a 1,000,000-cell
 *  legacy sheet is the largest legitimate user (see ./legacy-sheet.ts). */
export const READ_HEAP_MB = 768;

/** Reads at once in one process; the rest wait their turn. */
export const MAX_CONCURRENT_READS = 2;

let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= MAX_CONCURRENT_READS) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
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
  const err = new Error(e.message);
  if (e.name && e.name !== 'Error') err.name = e.name;
  if (e.code !== undefined) (err as Error & { code?: unknown }).code = e.code;
  return err;
}

/** True inside a read's own thread, where a nested read just runs. */
function inReadThread(): boolean {
  return !isMainThread && (workerData as { kind?: unknown } | null)?.kind === 'mantle-parse';
}

export type ReadLimits = { timeoutMs?: number; heapMb?: number };

/**
 * Run one read (a job in ./isolate-jobs.ts) in its own thread under the
 * limits above. Resolves with its result; rejects with the reader's own
 * error, or a {@link DocumentLimitError} when a limit stopped it.
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
  return withSlot(
    () =>
      new Promise<JobResult<K>>((resolve, reject) => {
        let worker: Worker;
        try {
          worker = new Worker(new URL('./isolate-worker.ts', import.meta.url), {
            workerData: { kind: 'mantle-parse', job, args },
            resourceLimits: { maxOldGenerationSizeMb: heapMb },
          });
        } catch (err) {
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
        const timer = setTimeout(
          () =>
            finish(() =>
              reject(
                new DocumentLimitError(
                  'timeout',
                  `Reading the file took longer than ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`} and was stopped.`,
                ),
              ),
            ),
          timeoutMs,
        );
        worker.once('message', (m: Reply) =>
          finish(() =>
            m.ok ? resolve(revive(m.result) as JobResult<K>) : reject(rebuild(m.error)),
          ),
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
      }),
  );
}
