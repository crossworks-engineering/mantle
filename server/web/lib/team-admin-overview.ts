/**
 * Shared aggregates for the /api/team-admin tab routes. Every tab response
 * embeds `badges` so the client tab strip renders identically no matter which
 * tab loaded first — one helper, one definition of "what's awaiting the
 * specialist".
 */
import { countOpenTeamRequests } from '@mantle/content';

export type TeamAdminBadges = {
  /** The Requests-tab badge: open change requests, everything awaiting the
   *  specialist. */
  openRequestCount: number;
};

export async function teamAdminBadges(userId: string): Promise<TeamAdminBadges> {
  // A count query, not the list (which stops at 100): the badge must agree
  // with the "needs you" count on every device.
  return { openRequestCount: await countOpenTeamRequests(userId) };
}
