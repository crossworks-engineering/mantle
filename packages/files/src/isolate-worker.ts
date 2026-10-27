/**
 * The thread half of ./isolate.ts: runs one document read and posts the
 * answer, or the error, back. A read that runs out of heap or time costs
 * this thread, which the parent then ends; the server's own heap and event
 * loop never see it.
 *
 * Loaded by URL as a worker, so this file uses erasable TypeScript only and
 * imports no sibling file statically: Node strips its types. The readers it
 * calls are ordinary TypeScript with extensionless imports, so they need tsx.
 * A server started by tsx passes its loader to the thread through execArgv
 * (the default); anywhere else (the test runner) the thread registers tsx
 * itself before importing them.
 *
 * The answer's binary parts (extracted pictures) are MOVED to the parent
 * (`transferList`), not copied: thirty pictures of a few MB each would
 * otherwise exist twice at the moment of the hand-over.
 */
import { parentPort, workerData } from 'node:worker_threads';

type Request = { kind: 'mantle-parse'; job: string; args: unknown[] };

/** A Buffer crosses a thread as a plain Uint8Array; make it a Buffer again,
 *  in arrays and plain objects a few levels down. ./isolate.ts has the same
 *  function for the way back (no sibling import here, see above). */
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

/**
 * The answer, with each byte array on an ArrayBuffer of its own, and those
 * ArrayBuffers listed for transfer. A Buffer that is a view of a larger
 * (pooled) ArrayBuffer is copied into its own first: transferring the pool
 * would move every other Buffer on it, and one ArrayBuffer may be listed
 * only once.
 */
function forTransfer(value: unknown, list: ArrayBuffer[], depth = 0): unknown {
  if (value instanceof Uint8Array) {
    const own =
      value.byteOffset === 0 &&
      value.byteLength === value.buffer.byteLength &&
      value.buffer instanceof ArrayBuffer &&
      !list.includes(value.buffer);
    const bytes = own ? value : new Uint8Array(value);
    list.push(bytes.buffer as ArrayBuffer);
    return bytes;
  }
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => forTransfer(v, list, depth + 1));
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = forTransfer(v, list, depth + 1);
  return out;
}

async function main(): Promise<void> {
  const request = workerData as Request;
  if (!process.execArgv.some((arg) => arg.includes('tsx'))) {
    const { register } = await import('tsx/esm/api');
    register();
  }
  const { runJob } = await import('./isolate-jobs.ts');
  try {
    const result = await runJob(
      request.job,
      request.args.map((a) => revive(a)),
    );
    const transfer: ArrayBuffer[] = [];
    const message = { ok: true, result: forTransfer(result, transfer) };
    parentPort?.postMessage(message, transfer);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    parentPort?.postMessage({
      ok: false,
      error: {
        name: e.name,
        message: e.message,
        code: (e as { code?: unknown }).code,
        reason: (e as { reason?: unknown }).reason,
      },
    });
  }
}

void main();
