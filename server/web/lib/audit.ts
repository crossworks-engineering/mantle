import { headers } from '../server/http-compat/headers';
import { db, auditLog } from '@mantle/db';
import { isDetachedDev } from './auth-constants';

/**
 * Human action trail (audit_log). Two producers:
 *  - the `getOwnerOr401` choke point in lib/auth.ts writes a generic `api.write`
 *    row for every mutating API call, and
 *  - auth + user-management routes write explicit, richer events
 *    (`auth.login`, `auth.login_failed`, `user.create`, …).
 *
 * Rows are attributed to the ACTOR (the logged-in login), never the anchor —
 * that attribution is the whole point of multi-admin logins. `actorEmail` is
 * denormalized so the trail survives user deletion.
 */

export type AuditEntry = {
  /** Nullable: a failed login for an unknown email has no actor id. */
  actorId?: string | null;
  actorEmail: string;
  action:
    | 'auth.login'
    | 'auth.login_failed'
    | 'auth.logout'
    | 'auth.token_refreshed'
    | 'auth.device_revoked'
    | 'auth.password_change'
    | 'user.create'
    | 'user.update'
    | 'user.delete'
    | 'user.password_reset'
    | 'api.write';
  method?: string | null;
  path?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | null;
};

export async function logAudit(entry: AuditEntry): Promise<void> {
  // Detached dev has no local Postgres — the insert would throw on every call.
  if (isDetachedDev()) return;
  await db.insert(auditLog).values({
    actorId: entry.actorId ?? null,
    actorEmail: entry.actorEmail,
    action: entry.action,
    method: entry.method ?? null,
    path: entry.path ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    detail: entry.detail ?? null,
  });
}

/** Audit must never break the request it describes: log-and-continue. */
export function auditFireAndForget(entry: AuditEntry): void {
  void logAudit(entry).catch((err) => {
    console.error(`[audit] failed to record ${entry.action}:`, err);
  });
}

/** Client ip + user-agent from the ambient request headers (Server Component /
 *  route-handler context). First X-Forwarded-For hop = original client. */
export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  return {
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    userAgent: h.get('user-agent') || null,
  };
}

/** Same, from an explicit `Request` (auth routes that already hold one). */
export function requestMetaFrom(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    userAgent: req.headers.get('user-agent') || null,
  };
}
