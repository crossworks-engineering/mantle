/**
 * Regression lock for the 2026-09-09 hang: an SDK that SWALLOWS the abort we
 * hand it must not be able to wedge a turn.
 *
 * The OpenRouter SDK classifies our connect-timeout `TimeoutError` as retryable
 * and — with its default `timeoutMs: -1` — re-sends against the same, already
 * aborted signal until its `maxElapsedTime` (one hour by default). The promise
 * we awaited stayed unsettled for that whole hour: no error, no timeout, and a
 * user Stop that visibly did nothing. `abortable` makes our abort terminal for
 * the caller regardless of what the SDK does with it, so these tests model the
 * swallowing SDK as a promise that simply never settles.
 */

import { describe, expect, it, vi } from 'vitest';
import { abortable, chatAbortSignal, streamAbort } from './sse';

/** An SDK call that ignores its signal entirely — the production failure. */
const neverSettles = () => new Promise<string>(() => {});

describe('abortable', () => {
  it('rejects when the signal aborts, even though the wrapped call never settles', async () => {
    const ctrl = new AbortController();
    const p = abortable(neverSettles(), ctrl.signal);
    ctrl.abort(new DOMException('chat stream connect timed out after 60000ms', 'TimeoutError'));
    await expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new DOMException('stopped', 'AbortError'));
    await expect(abortable(neverSettles(), ctrl.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('surfaces a generic AbortError when the signal carries no reason', async () => {
    const signal = { aborted: true, reason: undefined } as unknown as AbortSignal;
    await expect(abortable(neverSettles(), signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('passes a normal result straight through and detaches its listener', async () => {
    const ctrl = new AbortController();
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener');
    await expect(abortable(Promise.resolve('ok'), ctrl.signal)).resolves.toBe('ok');
    expect(remove).toHaveBeenCalled();
  });

  it('passes a rejection straight through', async () => {
    const ctrl = new AbortController();
    await expect(abortable(Promise.reject(new Error('boom')), ctrl.signal)).rejects.toThrow('boom');
  });

  it("the connect guard's own timeout reaches the caller through abortable", async () => {
    vi.useFakeTimers();
    try {
      // streamAbort arms the 60s connect timer; the SDK stalls forever.
      const abort = streamAbort(undefined, 60_000);
      const p = abortable(neverSettles(), abort.signal);
      const assertion = expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(60_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a user Stop reaches the caller through the one-shot chatAbortSignal', async () => {
    const stop = new AbortController();
    const p = abortable(neverSettles(), chatAbortSignal(stop.signal, 60_000));
    stop.abort(new DOMException('stopped', 'AbortError'));
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
