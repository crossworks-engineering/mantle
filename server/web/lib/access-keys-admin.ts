/**
 * The list side of inbound API keys (plan page 1e62e204): what the
 * Settings > API access screen shows. Never the secret, never its hash.
 */
import { and, count, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
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

const LIST_LIMIT = 500;

/** Keys newest first, with their login and maker: one login's (`loginId`),
 *  or every key (null, an admin's view). */
export async function listAccessKeys(loginId: string | null): Promise<AccessKeyView[]> {
  const rows = await db
    .select()
    .from(accessKeys)
    .where(loginId ? eq(accessKeys.loginId, loginId) : undefined)
    .orderBy(desc(accessKeys.createdAt))
    .limit(LIST_LIMIT);
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

/** A login's live keys: not revoked, not expired. */
export async function countLiveAccessKeys(loginId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(accessKeys)
    .where(
      and(
        eq(accessKeys.loginId, loginId),
        isNull(accessKeys.revokedAt),
        or(isNull(accessKeys.expiresAt), gt(accessKeys.expiresAt, new Date())),
      ),
    );
  return Number(row?.n ?? 0);
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
