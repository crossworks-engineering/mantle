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
};

export async function teamAdminBadges(userId: string): Promise<TeamAdminBadges> {
  const openRequestCount = await listTeamRequests(userId, { status: 'open' }).then((r) => r.length);
  return { openRequestCount };
}
