/**
 * Shared aggregates for the /api/team-admin tab routes. Every tab response
 * embeds `badges` so the client tab strip renders identically no matter which
 * tab loaded first — one helper, one definition of "what's awaiting the
 * specialist".
 */
import { listTeamRequests, countPendingForumUploads } from '@mantle/content';

export type TeamAdminBadges = {
  /** The Requests-tab badge: open change requests + forum uploads pending
   *  review — everything awaiting the specialist. */
  openRequestCount: number;
  /** Raw halves, for panes that need them (the uploads queue shows "N more"). */
  openRequests: number;
  pendingUploadCount: number;
};

export async function teamAdminBadges(userId: string): Promise<TeamAdminBadges> {
  const [openRequests, pendingUploadCount] = await Promise.all([
    listTeamRequests(userId, { status: 'open' }).then((r) => r.length),
    countPendingForumUploads(userId),
  ]);
  return { openRequestCount: openRequests + pendingUploadCount, openRequests, pendingUploadCount };
}
