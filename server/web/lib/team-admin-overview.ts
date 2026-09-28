/**
 * Shared aggregates for the /api/team-admin tab routes. Every tab response
 * embeds `badges` so the client tab strip renders identically no matter which
 * tab loaded first — one helper, one definition of "what's awaiting the
 * specialist".
 */
import { listTeamRequests } from '@mantle/content';

export type TeamAdminBadges = {
  /** The Requests-tab badge: open change requests, everything awaiting the
   *  specialist. */
  openRequestCount: number;
  /** Raw halves, kept in the shape older clients read. */
  openRequests: number;
  /** Always 0: forum uploads went with the forum (member logins Phase 6; the
   *  archive export filed the unreviewed ones). Kept one contract cycle for
   *  client builds that still read it. */
  pendingUploadCount: 0;
};

export async function teamAdminBadges(userId: string): Promise<TeamAdminBadges> {
  const openRequests = await listTeamRequests(userId, { status: 'open' }).then((r) => r.length);
  return { openRequestCount: openRequests, openRequests, pendingUploadCount: 0 };
}
