import { headers } from '../server/http-compat/headers';
import { systemDb, auditLog } from '@mantle/db';
// Infrastructure writes: systemDb (the admin pool) whatever the viewer, so a
// turn under a limited role (member logins Phase 0b) still records them.
import { isDetachedDev } from './auth-constants';
import { clientIpFromHeaders } from './rate-limit';

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
    // A member invite redeemed (member logins Phase 6), or a failed try.
    | 'auth.invite_accepted'
    | 'auth.invite_failed'
    // A client login signed in with an admin-issued link (client logins
    // C2), or a failed try; an admin issued or revoked a link.
    | 'auth.client_link_signin'
    | 'auth.client_link_failed'
    // The same for an emailed code (C2b); an admin chose the sign-in sender.
    | 'auth.client_code_signin'
    | 'auth.client_code_failed'
    | 'client.signin_sender_set'
    | 'client.signin_link_issued'
    | 'client.signin_link_revoked'
    // An admin removed every comment a client login wrote (C5 audit).
    | 'client.comments_deleted'
    | 'user.create'
    | 'user.update'
    | 'user.delete'
    | 'user.password_reset'
    // A login's personal assistant (migration 0143): bound, renamed, or
    // released. `release` never deletes the agent — the archive outlives the
    // binding, so the trail must say which agent was orphaned.
    | 'user.agent.assign'
    | 'user.agent.rename'
    | 'user.agent.release'
    | 'api.write';
  method?: string | null;
  path?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | null;
};

/** A personal-space route with an item id in it: the admin's own
 *  (/api/admin/space/<id>/…) or a member's (/api/member/space/<id>/…). */
const PERSONAL_ITEM_PATH = /^(\/api\/(?:admin|member)\/space)\/[^/?#]+/;

/**
 * The path as the trail keeps it. Every admin reads the audit log, and a
 * personal item's id belongs to its owner alone (final audit F31): it is
 * what a same-origin request for the item would need. So the id in a
 * personal-space path is kept as `:id`; the route and the actor still say
 * who did what.
 */
export function redactAuditPath(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.replace(PERSONAL_ITEM_PATH, '$1/:id');
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  // Detached dev has no local Postgres — the insert would throw on every call.
  if (isDetachedDev()) return;
  await systemDb.insert(auditLog).values({
    actorId: entry.actorId ?? null,
    actorEmail: entry.actorEmail,
    action: entry.action,
    method: entry.method ?? null,
    path: redactAuditPath(entry.path),
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
 *  route-handler context). The ip is the hop our proxy appended to
 *  X-Forwarded-For (`clientIp`, as the rate limiter keys it), never the
 *  leftmost entry: the caller writes that one, so an audit row naming it
 *  could be forged (client logins audit B16). */
export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  return metaOf(await headers());
}

/** Same, from an explicit `Request` (auth routes that already hold one). */
export function requestMetaFrom(req: Request): { ip: string | null; userAgent: string | null } {
  return metaOf(req.headers);
}

function metaOf(h: { get(name: string): string | null }): {
  ip: string | null;
  userAgent: string | null;
} {
  const ip = clientIpFromHeaders(h);
  return { ip: ip === 'unknown' ? null : ip, userAgent: h.get('user-agent') || null };
}
