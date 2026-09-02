/**
 * Stream time bounds (2026-09-02 audit): a stream that goes quiet must fail
 * loudly instead of hanging the turn, and the connect timer must stop
 * governing a healthy stream once headers are in.
 */
import { describe, expect, it } from 'vitest';
import { readSSE, streamAbort, withIdleTimeout } from './sse';

const enc = new TextEncoder();

/** A body that emits `frames` on a schedule: each entry is [delayMs, text];
 *  a `null` text means "never send anything again". */
function scheduledBody(frames: Array<[number, string | null]>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let t = 0;
      let closes = true;
      for (const [delay, text] of frames) {
        t += delay;
        if (text === null) {
          closes = false;
          continue;
        }
        setTimeout(() => controller.enqueue(enc.encode(text)), t);
      }
      if (closes) setTimeout(() => controller.close(), t + 1);
    },
  });
}

async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const p of gen) out.push(p);
  return out;
}

describe('readSSE idle timeout', () => {
  it('yields payloads while chunks keep arriving inside the idle window', async () => {
    const body = scheduledBody([
      [5, 'data: a\n\n'],
      [20, ': keep-alive comment\n'],
      [20, 'data: b\n\n'],
    ]);
    await expect(collect(readSSE(body, undefined, { idleMs: 60 }))).resolves.toEqual(['a', 'b']);
  });

  it('throws TimeoutError when the stream goes silent for longer than idleMs', async () => {
    const body = scheduledBody([
      [5, 'data: a\n\n'],
      [0, null],
    ]);
    const seen: string[] = [];
    let caught: unknown;
    try {
      for await (const p of readSSE(body, undefined, { idleMs: 40 })) seen.push(p);
    } catch (err) {
      caught = err;
    }
    expect(seen).toEqual(['a']);
    expect((caught as { name?: string })?.name).toBe('TimeoutError');
  });

  it('is unbounded without idleMs (legacy behaviour preserved)', async () => {
    const body = scheduledBody([
      [5, 'data: a\n\n'],
      [80, 'data: b\n\n'],
    ]);
    await expect(collect(readSSE(body))).resolves.toEqual(['a', 'b']);
  });
});

describe('withIdleTimeout', () => {
  async function* ticks(gaps: number[]): AsyncGenerator<number> {
    let i = 0;
    for (const g of gaps) {
      await new Promise((r) => setTimeout(r, g));
      yield i++;
    }
  }

  it('passes items through while they arrive in time', async () => {
    const out: number[] = [];
    for await (const v of withIdleTimeout(ticks([5, 5, 5]), 60)) out.push(v);
    expect(out).toEqual([0, 1, 2]);
  });

  it('throws TimeoutError and fires onIdle on a stall', async () => {
    let idled = 0;
    const out: number[] = [];
    let caught: unknown;
    try {
      for await (const v of withIdleTimeout(ticks([5, 200]), 40, () => idled++)) out.push(v);
    } catch (err) {
      caught = err;
    }
    expect(out).toEqual([0]);
    expect(idled).toBe(1);
    expect((caught as { name?: string })?.name).toBe('TimeoutError');
  });
});

describe('streamAbort', () => {
  it('aborts with TimeoutError when headers never arrive', async () => {
    const a = streamAbort(undefined, 20);
    await new Promise((r) => setTimeout(r, 40));
    expect(a.signal.aborted).toBe(true);
    expect((a.signal.reason as { name?: string })?.name).toBe('TimeoutError');
  });

  it('connected() stops the connect timer so a long stream is not cut', async () => {
    const a = streamAbort(undefined, 20);
    a.connected();
    await new Promise((r) => setTimeout(r, 40));
    expect(a.signal.aborted).toBe(false);
  });

  it('forwards the caller signal (user Stop) with its reason', () => {
    const ctrl = new AbortController();
    const a = streamAbort(ctrl.signal, 10_000);
    expect(a.signal.aborted).toBe(false);
    ctrl.abort('stop');
    expect(a.signal.aborted).toBe(true);
    expect(a.signal.reason).toBe('stop');
    a.connected();
  });

  it('abortIdle() tears the request down after headers', () => {
    const a = streamAbort(undefined, 10_000);
    a.connected();
    a.abortIdle();
    expect(a.signal.aborted).toBe(true);
    expect((a.signal.reason as { name?: string })?.name).toBe('TimeoutError');
  });
});
