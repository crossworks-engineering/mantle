/**
 * What a disabled login left behind (corporate plan section 10.4, decision D7;
 * docs/scim.md "Leavers"): the users area's report of one login, read
 * after a disable. A disable ends what the login could do (every session,
 * key and grant); it removes nothing it made. Its items stay where they
 * are, and an open share link of one of them keeps working (a share link
 * is often a business record, D7), so this lists them for an admin to keep
 * or revoke.
 *
 * Served only while company sign-in or SCIM is on (the route answers 404
 * otherwise), so a box with neither reads nothing new.
 *
 *  - `live`: what can still act as the login (0 for each after a disable;
 *    anything else is a problem to look at).
 *  - `privateItems`: the items whose home is the login's private workspace,
 *    by type.
 *  - `shares`: the live share links (open links and contact shares) of
 *    those items. A share link of an item homed elsewhere belongs to that
 *    workspace, not to the person, and is not listed.
 *  - `moderates`: the workspaces (other than its private one) the login
 *    moderates, and whether it is the only Moderator there.
 *  - `ownRows`: the per-login rows (its chats and what was learned from
 *    them), read only by the login.
 */
import {
  accessKeys,
  and,
  authUsers,
  db,
  eq,
  gt,
  isNull,
  itemHomeSql,
  liveWorkspace,
  mobileTokens,
  nodes,
  oauthAccessTokens,
  or,
  privateWorkspaces,
  scimUsers,
  shares,
  sql,
  workspaceUsers,
  workspaces,
  ne,
} from '@mantle/db';

export type LeaverReport = {
  login: {
    id: string;
    email: string;
    displayName: string | null;
    disabledAt: string | null;
    scim: { managed: boolean; externalId: string | null };
  };
  live: { apiKeys: number; mcpGrants: number; devices: number };
  privateItems: { workspaceId: string | null; total: number; byType: Record<string, number> };
  shares: Array<{
    shareId: string;
    nodeId: string;
    title: string;
    type: string;
    kind: 'open' | 'contact';
    createdAt: string;
    expiresAt: string | null;
    viewCount: number;
    lastViewedAt: string | null;
  }>;
  /** More live share links than SHARES_MAX: the list holds the first. */
  sharesTruncated: boolean;
  moderates: Array<{ workspaceId: string; name: string; onlyModerator: boolean }>;
  ownRows: number;
};

/** The most share links listed. */
const SHARES_MAX = 500;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const n = (v: unknown) => Number(v ?? 0);

/** The report of `loginId`, null when there is no such login, or
 *  'not-disabled' for a login still in use (read before anything else:
 *  management is not reading, docs/workspaces.md). */
export async function leaverReport(loginId: string): Promise<LeaverReport | 'not-disabled' | null> {
  const [login] = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      displayName: authUsers.displayName,
      disabledAt: authUsers.disabledAt,
      scimLogin: scimUsers.loginId,
      externalId: scimUsers.externalId,
      privateWs: privateWorkspaces.workspaceId,
    })
    .from(authUsers)
    .leftJoin(scimUsers, eq(scimUsers.loginId, authUsers.id))
    .leftJoin(privateWorkspaces, eq(privateWorkspaces.loginId, authUsers.id))
    .where(eq(authUsers.id, loginId))
    .limit(1);
  if (!login) return null;
  if (!login.disabledAt) return 'not-disabled';

  const now = new Date();
  const [[keys], [grants], [devices], [own]] = await Promise.all([
    db
      .select({ c: sql<number>`count(*)` })
      .from(accessKeys)
      .where(
        and(
          eq(accessKeys.loginId, loginId),
          isNull(accessKeys.revokedAt),
          or(isNull(accessKeys.expiresAt), gt(accessKeys.expiresAt, now)),
        ),
      ),
    db
      .select({ c: sql<number>`count(*)` })
      .from(oauthAccessTokens)
      .where(
        and(
          eq(oauthAccessTokens.actorId, loginId),
          isNull(oauthAccessTokens.revokedAt),
          or(gt(oauthAccessTokens.expiresAt, now), gt(oauthAccessTokens.refreshExpiresAt, now)),
        ),
      ),
    db
      .select({ c: sql<number>`count(*)` })
      .from(mobileTokens)
      .where(
        and(
          eq(mobileTokens.userId, loginId),
          isNull(mobileTokens.revokedAt),
          gt(mobileTokens.expiresAt, now),
        ),
      ),
    db
      .select({ c: sql<number>`count(*)` })
      .from(nodes)
      .where(eq(nodes.loginId, loginId)),
  ]);

  const ws = login.privateWs;
  const byType: Record<string, number> = {};
  let total = 0;
  let shareRows: LeaverReport['shares'] = [];
  let sharesTruncated = false;
  if (ws) {
    const types = await db
      .select({ type: nodes.type, c: sql<number>`count(*)` })
      .from(nodes)
      .where(eq(itemHomeSql(), ws))
      .groupBy(nodes.type);
    for (const t of types) {
      byType[t.type] = n(t.c);
      total += n(t.c);
    }
    const live = await db
      .select({
        shareId: shares.id,
        nodeId: shares.nodeId,
        title: nodes.title,
        type: nodes.type,
        contactId: shares.contactId,
        createdAt: shares.createdAt,
        expiresAt: shares.expiresAt,
        viewCount: shares.viewCount,
        lastViewedAt: shares.lastViewedAt,
      })
      .from(shares)
      .innerJoin(nodes, eq(nodes.id, shares.nodeId))
      .where(
        and(
          eq(itemHomeSql(), ws),
          isNull(shares.revokedAt),
          or(isNull(shares.expiresAt), gt(shares.expiresAt, now)),
        ),
      )
      .orderBy(shares.createdAt)
      .limit(SHARES_MAX + 1);
    sharesTruncated = live.length > SHARES_MAX;
    shareRows = live.slice(0, SHARES_MAX).map((s) => ({
      shareId: s.shareId,
      nodeId: s.nodeId,
      title: s.title,
      type: s.type,
      kind: s.contactId ? 'contact' : 'open',
      createdAt: s.createdAt.toISOString(),
      expiresAt: iso(s.expiresAt),
      viewCount: s.viewCount,
      lastViewedAt: iso(s.lastViewedAt),
    }));
  }

  // The workspaces it moderates (live ones, not its private one), and
  // whether another Moderator is there.
  const mods = await db
    .select({
      workspaceId: workspaces.id,
      name: workspaces.name,
      others: sql<number>`(select count(*) from workspace_users o
        where o.workspace_id = ${workspaces.id} and o.moderator and o.login_id <> ${loginId})`,
    })
    .from(workspaceUsers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceUsers.workspaceId))
    .where(
      and(
        eq(workspaceUsers.loginId, loginId),
        eq(workspaceUsers.moderator, true),
        liveWorkspace(),
        ws ? ne(workspaces.id, ws) : sql`true`,
      ),
    )
    .orderBy(workspaces.name);

  return {
    login: {
      id: login.id,
      email: login.email,
      displayName: login.displayName,
      disabledAt: iso(login.disabledAt),
      scim: { managed: login.scimLogin !== null, externalId: login.externalId },
    },
    live: { apiKeys: n(keys?.c), mcpGrants: n(grants?.c), devices: n(devices?.c) },
    privateItems: { workspaceId: ws, total, byType },
    shares: shareRows,
    sharesTruncated,
    moderates: mods.map((m) => ({
      workspaceId: m.workspaceId,
      name: m.name,
      onlyModerator: n(m.others) === 0,
    })),
    ownRows: n(own?.c),
  };
}
