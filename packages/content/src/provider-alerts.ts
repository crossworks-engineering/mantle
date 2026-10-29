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
import type { ProviderAlert } from '@mantle/client-types';
import { countExtractBacklog, isAlertShown, listOpenProviderAlerts } from '@mantle/db';

export const NEEDS_YOU_CHANGED_CHANNEL = 'needs_you_changed';
/** The change type the owner live stream sends for this event. */
export const NEEDS_YOU_REALTIME_TYPE = 'needs_you';

/**
 * The provider outages an admin sees: open and shown (permanent at once,
 * transient after 10 min), each with the extract jobs that wait. Safe text
 * only: the reason is fixed per error code, never provider text. A brain
 * before 0230 (no table) has none.
 */
export async function loadProviderAlerts(ownerId: string): Promise<ProviderAlert[]> {
  const rows = (await listOpenProviderAlerts(ownerId).catch(() => [])).filter(isAlertShown);
  if (rows.length === 0) return [];
  const waiting = await countExtractBacklog();
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
      waiting,
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}
