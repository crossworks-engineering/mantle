/**
 * The list side of inbound API keys (plan page 1e62e204): what the
 * Settings > API access screen shows. Never the secret, never its hash.
 */
import { and, desc, eq, gt, inArray, isNull, not, or } from 'drizzle-orm';
import { accessKeys, authUsers, db, type AccessKey } from '@mantle/db';
import type { AccessKeyStatus, AccessKeyView } from '@mantle/client-types';
import type { AccessKeyAccess, AccessKeyArea, AccessKeyRole } from './access-keys';

// The wire shapes are the contract package's (@crossworks/client-types).
export type { AccessKeyStatus, AccessKeyView };

export function accessKeyStatus(
  row: Pick<AccessKey, 'revokedAt' | 'expiresAt'>,
  now = Date.now(),
): AccessKeyStatus {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && row.expiresAt.getTime() <= now) return 'expired';
  return 'active';
}

/** Ended keys (revoked or expired) shown, newest first; every LIVE key is
 *  always shown (M3 audit item 9: an old live key must never drop off the
 *  list), and live keys are bounded by MAX_LIVE_KEYS_PER_LOGIN per login
 *  (final audit F7: an expired key counts as ended, not live). */
const ENDED_LIST_LIMIT = 200;

/** Keys newest first, with their login and maker: one login's (`loginId`),
 *  or every key (null, an admin's view). Every live key, then the newest
 *  ended ones. */
export async function listAccessKeys(loginId: string | null): Promise<AccessKeyView[]> {
  const mine = loginId ? eq(accessKeys.loginId, loginId) : undefined;
  const now = new Date();
  const live = and(
    isNull(accessKeys.revokedAt),
    or(isNull(accessKeys.expiresAt), gt(accessKeys.expiresAt, now)),
  );
  const [liveRows, endedRows] = await Promise.all([
    db.select().from(accessKeys).where(and(mine, live)).orderBy(desc(accessKeys.createdAt)),
    db
      .select()
      .from(accessKeys)
      .where(and(mine, not(live!)))
      .orderBy(desc(accessKeys.createdAt))
      .limit(ENDED_LIST_LIMIT),
  ]);
  const rows = [...liveRows, ...endedRows];
  const ids = [...new Set(rows.flatMap((r) => [r.loginId, ...(r.createdBy ? [r.createdBy] : [])]))];
  const logins = ids.length
    ? await db
        .select({
          id: authUsers.id,
          email: authUsers.email,
          displayName: authUsers.displayName,
        })
        .from(authUsers)
        .where(inArray(authUsers.id, ids))
    : [];
  const byId = new Map(logins.map((l) => [l.id, l]));
  return rows.map((r) => accessKeyView(r, byId, now.getTime()));
}

export function accessKeyView(
  r: AccessKey,
  logins: Map<string, { email: string | null; displayName: string | null }>,
  now = Date.now(),
): AccessKeyView {
  const login = logins.get(r.loginId);
  const maker = r.createdBy ? logins.get(r.createdBy) : undefined;
  return {
    id: r.id,
    name: r.name,
    prefix: `mtlk_${r.keyPrefix}`,
    login: {
      id: r.loginId,
      email: login?.email ?? null,
      displayName: login?.displayName ?? null,
      role: r.loginRole as AccessKeyRole,
    },
    access: r.access as AccessKeyAccess,
    areas: (r.areas as AccessKeyArea[] | null) ?? null,
    riskyTools: r.riskyTools,
    status: accessKeyStatus(r, now),
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy ? { id: r.createdBy, email: maker?.email ?? null } : null,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: r.lastUsedIp,
    revokedAt: r.revokedAt?.toISOString() ?? null,
  };
}
