/**
 * "Needs you": what waits for an admin (Jason, 2026-09-28: an admin must
 * never be blind to work waiting for them). Two queues: the Review queue
 * (items members submitted, and what deactivated logins left behind) and
 * open team requests. Since contact shares (0214), a third: contacts whose
 * sharing locked after 30 wrong codes in a day.
 *
 * The live event is `needs_you_changed` (migration 0186): database triggers
 * raise it, with the brain's owner id as the payload, whenever a space item
 * enters or leaves 'submitted' or 'taken', a login's role or deactivation
 * changes, or a team-request task opens or closes. A trigger cannot be
 * bypassed by a new write path. Its only listeners are the owner live stream
 * (server/web/lib/realtime.ts, admins only) and the push worker (admin
 * devices only). Notify-only: nothing here, and nothing listening, can start
 * LLM work.
 *
 * Since 0230 a fourth: embedding or extraction provider outages (no credits,
 * a refused key, a long outage; docs/embeddings.md "Provider outages"). Its
 * rows raise the same event when what an admin sees changes.
 *
 * The numbers come from count queries, never from a capped list, so every
 * window and device agrees. A notification names an item's title and who it
 * is from, never its content.
 */
import type { NeedsYou, ProviderAlert } from '@mantle/client-types';
import { countExtractBacklog, isAlertShown, listOpenProviderAlerts } from '@mantle/db';
import { countReviewQueue, newestSubmitted } from './member-review';
import { countOpenTeamRequests, listTeamRequests } from './team-requests';
import { lockedContactSharing } from './contact-share-codes';

export const NEEDS_YOU_CHANGED_CHANNEL = 'needs_you_changed';
/** The change type the owner live stream sends for this event. */
export const NEEDS_YOU_REALTIME_TYPE = 'needs_you';

export type { NeedsYou };

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

export async function loadNeedsYou(ownerId: string): Promise<NeedsYou> {
  const [queue, reviewNewest, open, [request], locked, providers] = await Promise.all([
    countReviewQueue(),
    newestSubmitted(),
    countOpenTeamRequests(ownerId),
    listTeamRequests(ownerId, { status: 'open', limit: 1 }),
    lockedContactSharing(ownerId),
    loadProviderAlerts(ownerId),
  ]);
  return {
    review: { submitted: queue.submitted, leftBehind: queue.leftBehind, newest: reviewNewest },
    requests: {
      open,
      newest: request
        ? {
            id: request.taskId,
            title: request.title,
            from: request.contactName?.trim() || 'A team member',
            at: request.createdAt,
          }
        : null,
    },
    sharing: {
      locked: locked.count,
      newest: locked.newest ? { ...locked.newest, from: '' } : null,
    },
    providers,
    total: queue.submitted + queue.leftBehind + open + locked.count + providers.length,
  };
}
