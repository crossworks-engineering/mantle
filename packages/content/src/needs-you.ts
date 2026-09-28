/**
 * "Needs you": what waits for an admin (Jason, 2026-09-28: an admin must
 * never be blind to work waiting for them). Two queues: the Review queue
 * (items members submitted, and what deactivated logins left behind) and
 * open team requests.
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
 * The numbers come from count queries, never from a capped list, so every
 * window and device agrees. A notification names an item's title and who it
 * is from, never its content.
 */
import type { NeedsYou } from '@mantle/client-types';
import { countReviewQueue, newestSubmitted } from './member-review';
import { countOpenTeamRequests, listTeamRequests } from './team-requests';

export const NEEDS_YOU_CHANGED_CHANNEL = 'needs_you_changed';
/** The change type the owner live stream sends for this event. */
export const NEEDS_YOU_REALTIME_TYPE = 'needs_you';

export type { NeedsYou };

export async function loadNeedsYou(ownerId: string): Promise<NeedsYou> {
  const [queue, reviewNewest, open, [request]] = await Promise.all([
    countReviewQueue(),
    newestSubmitted(),
    countOpenTeamRequests(ownerId),
    listTeamRequests(ownerId, { status: 'open', limit: 1 }),
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
    total: queue.submitted + queue.leftBehind + open,
  };
}
