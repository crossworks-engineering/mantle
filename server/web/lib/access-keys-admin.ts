/**
 * The list side of inbound API keys (plan page 1e62e204): what the
 * Settings > API access screen shows. Never the secret, never its hash.
 */
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
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

/** Revoked keys shown, newest first; every key not revoked is always
 *  shown (M3 audit item 9: an old live key must never drop off the list). */
const REVOKED_LIST_LIMIT = 200;

/** Keys newest first, with their login and maker: one login's (`loginId`),
 *  or every key (null, an admin's view). Every key not revoked, then the
 *  newest revoked ones. */
export async function listAccessKeys(loginId: string | null): Promise<AccessKeyView[]> {
  const mine = loginId ? eq(accessKeys.loginId, loginId) : undefined;
  const [live, revoked] = await Promise.all([
    db
      .select()
      .from(accessKeys)
      .where(and(mine, isNull(accessKeys.revokedAt)))
      .orderBy(desc(accessKeys.createdAt)),
    db
      .select()
      .from(accessKeys)
      .where(and(mine, isNotNull(accessKeys.revokedAt)))
      .orderBy(desc(accessKeys.createdAt))
      .limit(REVOKED_LIST_LIMIT),
  ]);
  const rows = [...live, ...revoked];
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
  const now = Date.now();
  return rows.map((r) => accessKeyView(r, byId, now));
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
