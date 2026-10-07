/**
 * The admin side of inbound API keys (plan page 1e62e204): the list the
 * Settings > API access screen shows, and the logins a key may act as.
 * Never the secret, never its hash.
 */
import { desc, inArray } from 'drizzle-orm';
import { accessKeys, authUsers, db, type AccessKey } from '@mantle/db';
import type { AccessKeyAccess, AccessKeyArea, AccessKeyRole } from './access-keys';

export type AccessKeyStatus = 'active' | 'expired' | 'revoked';

export type AccessKeyView = {
  id: string;
  name: string;
  /** `mtlk_<prefix>`: enough to tell keys apart, useless without the rest. */
  prefix: string;
  login: { id: string; email: string | null; displayName: string | null; role: AccessKeyRole };
  access: AccessKeyAccess;
  /** null = every area. */
  areas: AccessKeyArea[] | null;
  riskyTools: string[];
  status: AccessKeyStatus;
  expiresAt: string | null;
  createdAt: string;
  createdBy: { id: string; email: string | null } | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
};

export function accessKeyStatus(
  row: Pick<AccessKey, 'revokedAt' | 'expiresAt'>,
  now = Date.now(),
): AccessKeyStatus {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && row.expiresAt.getTime() <= now) return 'expired';
  return 'active';
}

const LIST_LIMIT = 500;

/** Every key, newest first, with its login and maker. */
export async function listAccessKeys(): Promise<AccessKeyView[]> {
  const rows = await db
    .select()
    .from(accessKeys)
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

export type AccessKeyLoginOption = {
  id: string;
  email: string;
  displayName: string | null;
  role: AccessKeyRole;
};

/**
 * The logins the calling admin may make a key for: their own login, and
 * every usable member and client login. Never another admin: a key that
 * acts as an admin is made by that admin.
 */
export async function accessKeyLoginOptions(actorId: string): Promise<AccessKeyLoginOption[]> {
  const rows = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      displayName: authUsers.displayName,
      role: authUsers.role,
      disabledAt: authUsers.disabledAt,
    })
    .from(authUsers)
    .where(inArray(authUsers.role, ['admin', 'member', 'client']));
  return rows
    .filter(
      (r): r is typeof r & { email: string } =>
        !!r.email && !r.disabledAt && (r.role !== 'admin' || r.id === actorId),
    )
    .map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.displayName,
      role: r.role as AccessKeyRole,
    }))
    .sort((a, b) =>
      a.id === actorId ? -1 : b.id === actorId ? 1 : a.email.localeCompare(b.email),
    );
}
