/**
 * HTTP plumbing (docs/provider-http.md "Timeouts, retries and health"): the
 * one timeout, retry and Retry-After helpers every network caller uses
 * instead of a copy of its own.
 *
 *  - {@link timeoutSignal}: the one deadline signal (optionally combined with
 *    a caller's own signal, a user Stop). The values come from the tables in
 *    ./timeouts.ts. A fetch that goes through a wrapper takes the wrapper's
 *    option instead (egressFetch `timeoutMs`, providerFetch `timeoutMs`), so
 *    there is no second fetch path.
 *  - {@link withTimeout}: race a promise against a deadline.
 *  - {@link withRetry} and {@link backoffMs}: one attempt loop; each caller
 *    states its own attempt budget, delays and retry set as options (the
 *    record tests pin them).
 *  - {@link parseRetryAfterMs}: the one Retry-After reader.
 *
 * No node builtins and no package imports: the browser bundles that import
 * `@mantle/std` stay clean.
 */

/** A deadline passed. `name` is `TimeoutError`, as the platform's
 *  `AbortSignal.timeout()` reason, so every classifier that reads the name
 *  (retry, failover, provider alerts) treats both alike. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** `ms` as people read it: `30 min`, `3 s`, `250 ms`. */
export function formatMs(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000} s`;
  return `${ms} ms`;
}

/**
 * A signal that aborts after `ms` (reason: a `TimeoutError` DOMException),
 * or when `signal` aborts, whichever comes first. The deadline covers
 * whatever the signal is handed to: for a fetch, the headers AND the body
 * read.
 */
export function timeoutSignal(ms: number, signal?: AbortSignal | null): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/**
 * Settle with `promise`, or reject with a {@link TimeoutError} (`<label> timed
 * out after <ms>`) once `ms` passes. The underlying work is not cancelled (a
 * promise cannot be); hand a {@link timeoutSignal} to work that can stop.
 * The timer is cleared on settle and never holds the process open.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError(`${label} timed out after ${formatMs(ms)}`)),
          ms,
        );
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** How a backoff grows and how much randomness it carries. */
export type BackoffShape = {
  /** The delay of step 0. */
  baseMs: number;
  /** Growth per step (default 2). */
  factor?: number;
  /** Ceiling on the grown delay, before jitter. Absent: none. */
  maxMs?: number;
  /**
   * `none` (default): the grown delay. `full`: a uniform pick in [0, delay],
   * rounded. `quarter`: the delay plus up to a quarter of it, floored.
   */
  jitter?: 'none' | 'full' | 'quarter';
};

/** The delay for backoff step `step` (0-based) of `shape`. */
export function backoffMs(step: number, shape: BackoffShape): number {
  const grown = shape.baseMs * (shape.factor ?? 2) ** step;
  const capped = shape.maxMs === undefined ? grown : Math.min(shape.maxMs, grown);
  switch (shape.jitter ?? 'none') {
    case 'full':
      return Math.round(Math.random() * capped);
    case 'quarter':
      return capped + Math.floor(Math.random() * capped * 0.25);
    default:
      return capped;
  }
}

/** What went wrong on one attempt: a thrown error, or a returned value the
 *  caller names a failure (an HTTP 429 response it wants to wait out). */
export type RetryFailure<T> =
  { error: unknown; value?: undefined } | { error?: undefined; value: T };

export type RetryOptions<T> = {
  /** Retries after the first try: the attempt budget is `retries + 1`. */
  retries: number;
  /** A returned value that is a failure to retry (default: none is). */
  isFailure?: (value: T) => boolean;
  /** Retry this failure? `retry` is the 1-based number of the retry about to
   *  be made. Default: a failing VALUE (`isFailure`) retries, a thrown error
   *  never does, so a caller retries only what it names. */
  retryOn?: (failure: RetryFailure<T>, retry: number) => boolean;
  /** The wait before retry `retry` (1-based); null gives up there (a wait
   *  that would pass a deadline). */
  delayMs: (retry: number, failure: RetryFailure<T>) => number | null;
  /** Before each wait: a log line, a body to release. */
  onRetry?: (info: {
    retry: number;
    retries: number;
    delayMs: number;
    failure: RetryFailure<T>;
  }) => void | Promise<void>;
  /** The wait (tests inject one). Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Run `fn` until it succeeds or the rules say stop. A thrown error that is
 * not retried is rethrown; a failing value that is not retried (the budget is
 * spent, `retryOn` says no, `delayMs` gives up) is returned as is, so the
 * caller handles the last answer as it would without retries.
 *
 * Cost safety: the budget is the caller's (`retries`). There is no default,
 * so no caller can gain retries by adopting this.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions<T>,
): Promise<T> {
  const wait = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    let failure: RetryFailure<T>;
    try {
      const value = await fn(attempt);
      if (!opts.isFailure?.(value)) return value;
      failure = { value };
    } catch (error) {
      failure = { error };
    }
    const retry = attempt + 1;
    const stop = (): T => {
      if ('value' in failure) return failure.value as T;
      throw failure.error;
    };
    if (retry > opts.retries) return stop();
    const retryable = opts.retryOn ? opts.retryOn(failure, retry) : 'value' in failure;
    if (!retryable) return stop();
    const delay = opts.delayMs(retry, failure);
    if (delay === null) return stop();
    await opts.onRetry?.({ retry, retries: opts.retries, delayMs: delay, failure });
    await wait(delay);
  }
}

type HeaderSource = { get?: (name: string) => string | null | undefined } | null | undefined;

/**
 * THE Retry-After reader: delta-seconds (fractions too) or an HTTP date
 * (RFC 9110), into milliseconds, never negative. Takes a Headers (or any
 * object with `get`; a mocked transport may hand back none), the header's
 * value, or a number of seconds (Telegram's `parameters.retry_after`).
 * From Headers, a `retry-after-ms` (Azure OpenAI and OpenAI send it on a
 * 429, finer than the seconds header) wins when it is a number.
 * Undefined when absent or unreadable.
 */
export function parseRetryAfterMs(
  source: HeaderSource | string | number,
  now: number = Date.now(),
): number | undefined {
  let raw: string | number | null | undefined;
  if (typeof source === 'string' || typeof source === 'number') raw = source;
  else {
    const msRaw = source?.get?.('retry-after-ms');
    const ms = msRaw == null || msRaw === '' ? NaN : Number(msRaw);
    if (Number.isFinite(ms)) return Math.max(0, ms);
    raw = source?.get?.('retry-after');
  }
  if (raw === null || raw === undefined || raw === '') return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  if (typeof raw !== 'string') return undefined;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return undefined;
}
