/**
 * The designated team-hub app, resolved to its team-mode share.
 *
 * What is left of the Team Hub reads: the /team workspace, the /hub briefing
 * sections, the app launcher, the stat tiles and the curated dashboard went
 * with the team-code portal in member logins Phase 6 (a member login's home is
 * GET /api/member/home, resolveMemberHomeApp in member-apps.ts). This resolver
 * is kept for the share-backed designation until stage 6 retires team-mode
 * share admission.
 */
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { apps, db, shares } from '@mantle/db';

export type TeamHubApp = {
  /** The designated app's node id (== prefs.teamHubAppId). */
  appNodeId: string;
  /** Active team-mode share token — the shell's AppSandbox brokers through
   *  /s/<token>/{bundle,tool-broker,db-broker}. */
  shareToken: string;
};

/**
 * Resolve a brain's designated team-hub app to its share. Honoured only when the WHOLE chain is intact:
 * pref (caller passes prefs.teamHubAppId) → app exists under this owner →
 * green PUBLISHED build → active TEAM-mode share. Any broken link ⇒ null ⇒
 * the built-in hub renders — designation must never produce a blank page.
 *
 * Read-only on purpose: share creation happens at designation time
 * (/team-admin), never as a side effect of a member loading the hub.
 */
export async function resolveTeamHubApp(
  ownerId: string,
  teamHubAppId: string | undefined,
): Promise<TeamHubApp | null> {
  if (!teamHubAppId) return null;
  const [row] = await db
    .select({ token: shares.token, publishedBuild: apps.publishedBuild })
    .from(shares)
    .innerJoin(apps, eq(apps.nodeId, shares.nodeId))
    .where(
      and(
        eq(shares.ownerId, ownerId),
        eq(shares.nodeId, teamHubAppId),
        eq(shares.nodeType, 'app'),
        sql`${shares.settings}->>'mode' = 'team'`,
        isNull(shares.revokedAt),
        or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date())),
      ),
    )
    .limit(1);
  if (!row || row.publishedBuild?.ok !== true) return null;
  return { appNodeId: teamHubAppId, shareToken: row.token };
}
