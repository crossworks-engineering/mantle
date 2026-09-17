/**
 * The empty-stop rule (2026-09-09 regression lock). A turn that ends aborted
 * with nothing to show must be recorded as a failure, not as a 'complete' turn
 * with a 0-character reply — that is what hid two hour-long hangs from every
 * failure count on the day this was written.
 */

import { describe, expect, it } from 'vitest';
import { STALLED_MESSAGE, STOPPED_MESSAGE, stoppedWithoutOutput } from './stopped-turn';

function aborted(reason?: unknown): AbortSignal {
  const c = new AbortController();
  c.abort(reason);
  return c.signal;
}

describe('stoppedWithoutOutput', () => {
  it('flags a provider stall as a timeout failure', () => {
    const signal = aborted(new DOMException('connect timed out', 'TimeoutError'));
    expect(stoppedWithoutOutput(signal, '')).toBe(STALLED_MESSAGE);
  });

  it('flags a user Stop that produced nothing', () => {
    expect(stoppedWithoutOutput(aborted(new DOMException('stop', 'AbortError')), '')).toBe(
      STOPPED_MESSAGE,
    );
  });

  it('treats whitespace-only output as nothing', () => {
    expect(stoppedWithoutOutput(aborted(), '   \n  ')).toBe(STOPPED_MESSAGE);
  });

  it('keeps a stop that DID stream a partial reply — a partial answer is an answer', () => {
    const signal = aborted(new DOMException('stop', 'AbortError'));
    expect(stoppedWithoutOutput(signal, 'Grace and peace, Jason.')).toBeNull();
  });

  it('never fires on a turn that was not aborted', () => {
    expect(stoppedWithoutOutput(new AbortController().signal, '')).toBeNull();
    expect(stoppedWithoutOutput(null, '')).toBeNull();
    expect(stoppedWithoutOutput(undefined, '')).toBeNull();
  });
});
