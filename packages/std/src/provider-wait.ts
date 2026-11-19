/**
 * The provider is the cap (owner decision 2026-11-19, "no, your provider can
 * be the cap there, lets not add limits"): paid work has no limit of the
 * brain's own. Where the model provider refuses for now, the work WAITS and
 * is tried again later; it is never dropped (docs/provider-http.md, "When the
 * provider refuses for now").
 *
 * "For now" is three answers, and only these:
 *  - `rate_limit`: 429 (too many calls now);
 *  - `quota`: 402, or a 429 or 403 that says the account has no credits;
 *  - `overloaded`: 503 or 529 (the provider is busy).
 *
 * A refusal of the content (a 400, a model that cannot read it) is not a
 * wait: it is reported as before, never tried again forever. Nor is any
 * other failure (a 500, a timeout): each keeps the handling it has.
 *
 * Pure, no node builtins (browser bundles import @mantle/std).
 */
import { withRetry } from './http';
import { classifyProviderError, providerErrorStatus } from './provider-error';

export type ProviderWaitReason = 'rate_limit' | 'quota' | 'overloaded';

export const PROVIDER_WAIT_REASONS: readonly ProviderWaitReason[] = [
  'rate_limit',
  'quota',
  'overloaded',
];

/** A provider's "not now": why, its status, and how long it asked for. */
export type ProviderWait = {
  reason: ProviderWaitReason;
  status?: number;
  retryAfterMs?: number;
};

/** One sentence for a person, per reason. Fixed text, never a provider body. */
export const PROVIDER_WAIT_TEXT: Readonly<Record<ProviderWaitReason, string>> = {
  rate_limit:
    'Waiting for the model provider: it is limiting how fast it answers. The work stays queued and is tried again by itself.',
  quota:
    'Waiting for the model provider: the account has no credit left. The work stays queued and goes on once credit is added.',
  overloaded:
    'Waiting for the model provider: it is busy just now. The work stays queued and is tried again by itself.',
};

/** The statuses of "busy" a provider answers (529: Anthropic's overloaded). */
const OVERLOADED_STATUS: ReadonlySet<number> = new Set([503, 529]);

/** `err` and the causes below it (a wrapper keeps the provider's error as
 *  its cause). */
function chain(err: unknown): object[] {
  const out: object[] = [];
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e && typeof e === 'object' && !out.includes(e); depth += 1) {
    out.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}

function retryAfterOf(err: unknown): number | undefined {
  for (const e of chain(err)) {
    const ms = (e as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) return ms;
  }
  return undefined;
}

/**
 * Raised where a paid call's "not now" must leave the work in its queue: the
 * extract queue sees it and sends the job again later (never to the dead
 * letters). `what` names the call (`vision`, `document`, `scan_reader`,
 * `transcribe`), for the trace.
 */
export class ProviderWaitError extends Error {
  readonly wait: ProviderWait;
  readonly what: string;
  constructor(wait: ProviderWait, what: string) {
    super(`${what}: ${PROVIDER_WAIT_TEXT[wait.reason]}`);
    this.name = 'ProviderWaitError';
    this.wait = wait;
    this.what = what;
  }
}

/**
 * The provider's "not now" in `err`, or null when `err` is anything else (a
 * refusal of the content, a 500, a timeout, our own bug). Reads a
 * ProviderWaitError first, then the provider's own error (the cause first,
 * as classifyProviderError does).
 */
export function providerWaitOf(err: unknown): ProviderWait | null {
  if (err === null || err === undefined) return null;
  for (const e of chain(err)) {
    if (e instanceof ProviderWaitError) return e.wait;
    if ((e as { name?: unknown }).name === 'ProviderWaitError') {
      const w = (e as { wait?: unknown }).wait as ProviderWait | undefined;
      if (w && PROVIDER_WAIT_REASONS.includes(w.reason)) return w;
    }
  }
  const cls = classifyProviderError(err);
  if (!cls) return null;
  const retryAfterMs = retryAfterOf(err);
  const extra = {
    ...(cls.status !== undefined ? { status: cls.status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
  if (cls.code === 'quota') return { reason: 'quota', ...extra };
  if (cls.code === 'rate_limit') return { reason: 'rate_limit', ...extra };
  if (cls.code === 'server') {
    const status = cls.status ?? providerErrorStatus(err);
    if (status !== undefined && OVERLOADED_STATUS.has(status)) {
      return { reason: 'overloaded', ...extra, status };
    }
  }
  return null;
}

/** The first wait; doubled each time the job waits again. */
const FIRST_WAIT_MS = 60_000;
/** The longest gap between two tries of one waiting job. A gap, not a
 *  limit: the job keeps its place and is tried again after it. */
export const PROVIDER_WAIT_MAX_GAP_MS = 60 * 60_000;
/** The longest a provider's own Retry-After moves a try. */
const RETRY_AFTER_MAX_MS = 6 * 60 * 60_000;

/**
 * When to try a waiting job again: 1, 2, 4, 8, 16, 32 minutes, then every
 * hour, for as long as the provider says "not now". `waits` is how many
 * times this job has waited before (0 the first time). A provider's own
 * Retry-After that asks for longer is honoured (up to six hours).
 */
export function providerWaitDelayMs(waits: number, wait?: ProviderWait): number {
  const n = Math.max(0, Math.min(Math.floor(waits), 20));
  const gap = Math.min(PROVIDER_WAIT_MAX_GAP_MS, FIRST_WAIT_MS * 2 ** n);
  const asked = wait?.retryAfterMs;
  return asked !== undefined && asked > gap ? Math.min(asked, RETRY_AFTER_MAX_MS) : gap;
}

/** The pauses of {@link callThroughWaits}: short, inside one job, so a read
 *  of many calls resumes where it stopped and pays nothing twice. */
export const PROVIDER_WAIT_IN_JOB_MS: readonly number[] = [15_000, 45_000, 90_000];

/**
 * One call of a read of many (the pages of a scan, the pictures of a
 * drawing), through a short "not now": when the call's answer is a rate
 * limit or a busy provider, wait a little and make the SAME call again, so
 * the read goes on from there and nothing it paid for is asked again. A
 * quota answer is not waited for here (credit does not come back in a
 * minute). Gives back the last answer: a caller that still has a wait raises
 * ProviderWaitError and the queue takes it from there. `waitOf` reads the
 * answer's wait (a worker's result carries it as `wait`). `sleep` is for a
 * test.
 */
export function callThroughWaits<T>(
  call: () => Promise<T>,
  waitOf: (answer: T) => ProviderWait | null | undefined,
  opts: { pauses?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const pauses = opts.pauses ?? PROVIDER_WAIT_IN_JOB_MS;
  return withRetry(() => call(), {
    retries: pauses.length,
    // A quota answer is no failure to wait out here: it goes back at once.
    isFailure: (answer) => {
      const wait = waitOf(answer);
      return !!wait && wait.reason !== 'quota';
    },
    delayMs: (retry, failure) =>
      inJobPause(
        pauses[retry - 1]!,
        failure.value !== undefined ? waitOf(failure.value) : undefined,
      ),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });
}

/** One pause inside a job: the pause, or the provider's Retry-After when
 *  it asks for longer, at most twice the pause. */
export function inJobPause(pause: number, wait: ProviderWait | null | undefined): number {
  const asked = wait?.retryAfterMs;
  return asked !== undefined && asked > pause ? Math.min(asked, 2 * pause) : pause;
}
