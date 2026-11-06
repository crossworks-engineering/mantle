/**
 * The wait of one agent UI call (docs/agent-ui.md): read the call's row
 * until the window answered it, the person stopped the turn, or the call
 * expired. It polls the row every UI_POLL_MS, and a NOTIFY on ui_result
 * wakes it early in a process that LISTENs (server/api: ui-result.ts calls
 * wakeUiCall). With no listener the poll alone answers, so the wait works in
 * any process on either runtime.
 */
import type { UiCallRow } from '@mantle/db';

/** How often the wait reads the row when nothing woke it, ms. */
export const UI_POLL_MS = 200;

/** How a wait ended. */
export type UiWaitOutcome =
  { kind: 'done'; result: Record<string, unknown> } | { kind: 'stopped' } | { kind: 'window_gone' };

/** What the wait needs, injectable for tests. */
export type UiWaitDeps = {
  read: (callId: string) => Promise<Pick<UiCallRow, 'status' | 'result'> | null>;
  now: () => number;
  /** Resolve after `ms`, or sooner when the call is woken or `signal`
   *  aborts. */
  pause: (callId: string, ms: number, signal?: AbortSignal) => Promise<void>;
};

const wakers = new Map<string, Set<() => void>>();

/** Wake the wait of `callId` (its answer or a Stop landed). A no-op when no
 *  wait of this process holds it. */
export function wakeUiCall(callId: string): void {
  const set = wakers.get(callId);
  if (!set) return;
  wakers.delete(callId);
  for (const fn of set) fn();
}

/** The default pause: a timer, a wake, or the abort, whichever is first. */
export function pauseForUiCall(callId: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let set = wakers.get(callId);
    if (!set) {
      set = new Set();
      wakers.set(callId, set);
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      const s = wakers.get(callId);
      s?.delete(done);
      if (s && s.size === 0) wakers.delete(callId);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    set.add(done);
    if (signal) {
      if (signal.aborted) done();
      else signal.addEventListener('abort', done, { once: true });
    }
  });
}

/** Wait for call `callId` until `expiresAtMs`. A row answered `done` is the
 *  window's result, whenever it is read; an `expired` row (a Stop) or an
 *  aborted turn is `stopped`; no answer by the deadline is `window_gone`. */
export async function waitForUiAnswer(
  callId: string,
  expiresAtMs: number,
  deps: UiWaitDeps,
  signal?: AbortSignal,
): Promise<UiWaitOutcome> {
  for (;;) {
    const row = await deps.read(callId);
    if (!row) return { kind: 'window_gone' };
    if (row.status === 'done') return { kind: 'done', result: row.result ?? {} };
    if (row.status === 'expired' || signal?.aborted) return { kind: 'stopped' };
    const left = expiresAtMs - deps.now();
    if (left <= 0) return { kind: 'window_gone' };
    await deps.pause(callId, Math.min(UI_POLL_MS, left), signal);
  }
}
