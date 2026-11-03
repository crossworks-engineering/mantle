/**
 * Provider outages an admin sees (migration 0230, docs/embeddings.md
 * "Provider outages"): embedding or extraction failing for no credits, a
 * refused key or a long outage.
 *
 * The live event is still `needs_you_changed` (migration 0186): database
 * triggers raise it, with the brain's owner id as the payload, when what an
 * admin sees changes. Its listeners are the owner live stream
 * (server/web/lib/realtime.ts, admins only) and the push worker (admin
 * devices only). Notify-only: nothing listening can start LLM work.
 *
 * There is no review queue; a team request is a task on the Tasks board.
 */
import type { DeciderLastFailure, ProviderAlert, ProviderAlertsAnswer } from '@mantle/client-types';
import {
  countExtractBacklog,
  getDefaultWorker,
  getProviderAlert,
  isAlertShown,
  isProbedSubject,
  listOpenProviderAlerts,
  type AiWorker,
  type DeciderParams,
  type ProviderAlertRow,
} from '@mantle/db';

export const NEEDS_YOU_CHANGED_CHANNEL = 'needs_you_changed';
/** The change type the owner live stream sends for this event. */
export const NEEDS_YOU_REALTIME_TYPE = 'needs_you';

/**
 * Pure: whether an open `decision` row is about the decider that runs now.
 * It is not when no enabled decider runs, when every use is off, or when the
 * worker's model changed: then no decision is made, so none can close it.
 */
export function deciderAlertApplies(
  row: Pick<ProviderAlertRow, 'model' | 'resolvedAt'>,
  worker: Pick<AiWorker, 'model' | 'params'> | null,
): boolean {
  if (row.resolvedAt !== null || !worker) return false;
  // Read the switches directly: @mantle/decisions (resolveUse) is not a
  // dependency of this package. Missing = off, as there.
  const uses = (worker.params as DeciderParams | null)?.uses ?? {};
  if (!Object.values(uses).some((u) => u?.enabled === true)) return false;
  return row.model === worker.model;
}

/** The enabled default decider (getDefaultWorker returns enabled ones only). */
function runningDecider(ownerId: string): Promise<AiWorker | null> {
  return getDefaultWorker(ownerId, 'decider').catch(() => null);
}

/**
 * The provider outages an admin sees: open and shown (permanent at once,
 * transient after 10 min), each with the extract jobs that wait. A
 * `decision` row counts only while it applies (`deciderAlertApplies`).
 * Safe text only: the reason is fixed per error code, never provider text.
 * A brain before 0230 (no table) has none. Push reads this list whole; the
 * HTTP answers split it (`splitProviderAlerts`).
 */
export async function loadProviderAlerts(ownerId: string): Promise<ProviderAlert[]> {
  let rows = (await listOpenProviderAlerts(ownerId).catch(() => [])).filter(isAlertShown);
  if (rows.some((r) => r.subject === 'decision')) {
    const worker = await runningDecider(ownerId);
    rows = rows.filter((r) => r.subject !== 'decision' || deciderAlertApplies(r, worker));
  }
  if (rows.length === 0) return [];
  // Extract jobs wait only on the subjects the queue pauses on.
  const waiting = rows.some((r) => isProbedSubject(r.subject)) ? await countExtractBacklog() : null;
  return rows
    .map((r) => ({
      subject: r.subject as ProviderAlert['subject'],
      code: r.code,
      permanent: r.permanent,
      reason: r.reason,
      provider: r.provider,
      model: r.model,
      since: r.failingSince.toISOString(),
      paused: r.paused,
      nextProbeAt: r.nextProbeAt?.toISOString() ?? null,
      waiting: isProbedSubject(r.subject) ? waiting : null,
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

/**
 * Pure: the HTTP answers' split. `alerts` keeps the subjects every released
 * client knows (embedding, extraction); the rest go in `otherAlerts`, which
 * an older client ignores instead of failing on a subject it does not know.
 */
export function splitProviderAlerts(list: ProviderAlert[]): ProviderAlertsAnswer {
  return {
    alerts: list.filter((a) => isProbedSubject(a.subject)),
    otherAlerts: list.filter((a) => !isProbedSubject(a.subject)),
  };
}

/**
 * The decider's last failure for its worker screen: the `decision` alert
 * row, open or closed (a closed row is the record of the last failure).
 * Null when the decider never failed, and on a brain whose table has no
 * such row yet. Safe text only, as above.
 */
export async function loadDeciderLastFailure(ownerId: string): Promise<DeciderLastFailure | null> {
  const r = await getProviderAlert(ownerId, 'decision').catch(() => null);
  if (!r) return null;
  const current = r.resolvedAt === null && deciderAlertApplies(r, await runningDecider(ownerId));
  return {
    code: r.code,
    permanent: r.permanent,
    reason: r.reason,
    provider: r.provider,
    model: r.model,
    since: r.failingSince.toISOString(),
    lastAt: r.lastErrorAt.toISOString(),
    count: r.errorCount,
    shown: isAlertShown(r),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    current,
  };
}
