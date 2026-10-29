/**
 * The list side of inbound API keys: what the
 * Settings > API access screen shows. Never the secret, never its hash.
 */
import { sql } from 'drizzle-orm';
import { db, type AccessKey } from '@mantle/db';
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
 *  always shown (an old live key must never drop off the list), and live
 *  keys are bounded by MAX_LIVE_KEYS_PER_LOGIN per login (an expired key
 *  counts as ended, not live). */
const ENDED_LIST_LIMIT = 200;

/** Keys newest first, with their login and maker: one login's (`loginId`),
 *  or every key (null, an Admin user's view). Every live key, then the
 *  newest ended ones. By their definer (mantle_access_keys_seen, 0293): the
 *  workspace role reads neither the keys nor a login's email; in a scope
 *  only the scope's own login's keys, or every key for an Admin user. Never
 *  the key's hash. */
export async function listAccessKeys(loginId: string | null): Promise<AccessKeyView[]> {
  const rows = (await db.execute(
    sql`select * from "public"."mantle_access_keys_seen"(${loginId}::uuid, ${ENDED_LIST_LIMIT})`,
  )) as unknown as {
    id: string;
    name: string;
    key_prefix: string;
    login_id: string;
    access: string;
    areas: string[] | null;
    risky_tools: string[];
    expires_at: Date | string | null;
    created_by: string | null;
    created_at: Date | string;
    last_used_at: Date | string | null;
    last_used_ip: string | null;
    revoked_at: Date | string | null;
    login_email: string | null;
    login_name: string | null;
    login_role: string | null;
    maker_email: string | null;
  }[];
  const at = (v: Date | string | null) => (v === null ? null : new Date(v));
  const logins = new Map<
    string,
    { email: string | null; displayName: string | null; role?: string }
  >();
  for (const r of rows) {
    logins.set(r.login_id, {
      email: r.login_email,
      displayName: r.login_name,
      ...(r.login_role ? { role: r.login_role } : {}),
    });
    if (r.created_by && !logins.has(r.created_by)) {
      logins.set(r.created_by, { email: r.maker_email, displayName: null });
    }
  }
  const now = Date.now();
  return rows.map((r) =>
    accessKeyView(
      {
        id: r.id,
        name: r.name,
        keyPrefix: r.key_prefix,
        loginId: r.login_id,
        access: r.access,
        areas: r.areas,
        riskyTools: r.risky_tools,
        expiresAt: at(r.expires_at),
        createdBy: r.created_by,
        createdAt: new Date(r.created_at),
        lastUsedAt: at(r.last_used_at),
        lastUsedIp: r.last_used_ip,
        revokedAt: at(r.revoked_at),
      },
      logins,
      now,
    ),
  );
}

export function accessKeyView(
  r: Pick<
    AccessKey,
    | 'id'
    | 'name'
    | 'keyPrefix'
    | 'loginId'
    | 'access'
    | 'areas'
    | 'riskyTools'
    | 'expiresAt'
    | 'createdBy'
    | 'createdAt'
    | 'lastUsedAt'
    | 'lastUsedIp'
    | 'revokedAt'
  >,
  logins: Map<string, { email: string | null; displayName: string | null; role?: string }>,
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
      // The login as it is now: a key keeps no role of its own.
      role: login?.role === 'admin' ? 'admin' : ('member' as AccessKeyRole),
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
