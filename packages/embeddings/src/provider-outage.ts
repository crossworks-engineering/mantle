/**
 * Report provider outcomes to the alert store (@mantle/db provider-alerts.ts,
 * migration 0230), cheaply and without ever breaking the call that reports.
 *
 *  - A failure is classified (provider-error.ts). Null = says nothing about
 *    the provider (a bad input): not recorded. Otherwise ONE row write per
 *    brain and subject per minute in this process, so a burst of failing
 *    jobs is a few writes, not one per call.
 *  - A success closes an open alert. Whether one is open is read at most
 *    once a minute per process (and known at once after this process wrote a
 *    failure), so the hot embed path pays nothing while all is well.
 *
 * Every call is fire-and-forget: a DB hiccup here must never fail an embed
 * that worked, nor hide the real error of one that did not.
 */
import {
  recordProviderFailure,
  resolveProviderAlert,
  listOpenProviderAlerts,
  type ProviderSubject,
} from '@mantle/db';
import { classifyProviderError, type ProviderErrorClass } from './provider-error';

export type { ProviderSubject };

const FAILURE_WRITE_EVERY_MS = 60_000;
const OPEN_CHECK_EVERY_MS = 60_000;

const lastFailureWrite = new Map<string, number>();
const openKnown = new Map<string, { open: boolean; at: number }>();

const key = (ownerId: string, subject: ProviderSubject) => `${ownerId}:${subject}`;

/** Mark an error with the subject that raised it, so a caller further up (the
 *  extract queue) knows an embedding failure from a chat one. */
export function tagProviderSubject(
  err: unknown,
  subject: ProviderSubject,
  provider?: string,
): void {
  if (err && typeof err === 'object' && !('providerSubject' in err)) {
    try {
      Object.assign(err, {
        providerSubject: subject,
        ...(provider ? { providerId: provider } : {}),
      });
    } catch {
      /* a frozen error: the caller falls back to its default subject */
    }
  }
}

/** The subject an error was tagged with, if any. */
export function providerSubjectOf(err: unknown): ProviderSubject | undefined {
  const s = (err as { providerSubject?: unknown } | null)?.providerSubject;
  return s === 'embedding' || s === 'extraction' ? s : undefined;
}

/**
 * Record a failure (throttled). Returns the classification so a caller can
 * act on it (the extract queue's circuit); null = not a provider problem.
 */
export function noteProviderFailure(
  ownerId: string,
  subject: ProviderSubject,
  err: unknown,
  ctx: { provider?: string | null; model?: string | null } = {},
  now: number = Date.now(),
): ProviderErrorClass | null {
  const cls = classifyProviderError(err);
  if (!cls) return null;
  const k = key(ownerId, subject);
  const last = lastFailureWrite.get(k) ?? 0;
  if (now - last < FAILURE_WRITE_EVERY_MS) return cls;
  lastFailureWrite.set(k, now);
  openKnown.set(k, { open: true, at: now });
  try {
    void recordProviderFailure(ownerId, subject, {
      code: cls.code,
      permanent: cls.permanent,
      reason: cls.reason,
      provider: ctx.provider ?? null,
      model: ctx.model ?? null,
    }).catch((e) => warn('record failure', e));
  } catch (e) {
    warn('record failure', e);
  }
  return cls;
}

/** A provider call worked: close an open alert for this subject. */
export function noteProviderSuccess(
  ownerId: string,
  subject: ProviderSubject,
  now: number = Date.now(),
): void {
  const k = key(ownerId, subject);
  const known = openKnown.get(k);
  if (known && !known.open && now - known.at < OPEN_CHECK_EVERY_MS) return;
  // Stale or unknown: one read decides, then the answer holds for a minute.
  openKnown.set(k, { open: false, at: now });
  lastFailureWrite.delete(k);
  try {
    void (async () => {
      const open = known?.open
        ? true
        : (await listOpenProviderAlerts(ownerId)).some((r) => r.subject === subject);
      if (open && (await resolveProviderAlert(ownerId, subject))) {
        console.log(`[provider-alerts] ${subject} works again: alert closed`);
      }
    })().catch((e) => warn('record success', e));
  } catch (e) {
    warn('record success', e);
  }
}

/** Forget this process's view (tests, or after a config change). */
export function resetProviderOutageCache(): void {
  lastFailureWrite.clear();
  openKnown.clear();
}

let warned = false;
function warn(what: string, e: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(
    `[provider-alerts] could not ${what} (logged once per process):`,
    e instanceof Error ? e.message : e,
  );
}
