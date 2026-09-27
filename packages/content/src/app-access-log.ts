/**
 * Audit writes for the external app-share surface. Every visitor action on
 * /s/<token>/* lands one row: WHO (contactId, or null for an anonymous
 * public-mode visitor), WHAT (kind + detail), on WHICH app. A member login
 * running an app from the member shell lands the same rows with `actorId`
 * (member logins Phase 4b). This is the
 * "the app registers who it's for" half of the team-token design — the token
 * carries identity, this table remembers it.
 *
 * Fire-and-forget by design: `recordAppAccess` swallows failures so an audit
 * hiccup can never take down a working app for a visitor. It must stay a
 * best-effort trail, not a gate.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, systemDb, appAccessLog, authUsers, nodes } from '@mantle/db';

export type AppAccessKind = 'auth' | 'tool' | 'db';

export type AppAccessEntry = {
  ownerId: string;
  appNodeId: string;
  shareId?: string | null;
  contactId?: string | null;
  /** The member login (member shell runs); null on share-link rows. */
  actorId?: string | null;
  kind: AppAccessKind;
  detail?: Record<string, unknown>;
};

export function recordAppAccess(entry: AppAccessEntry): void {
  // systemDb: an access record is written even under a limited viewer role.
  void systemDb
    .insert(appAccessLog)
    .values({
      ownerId: entry.ownerId,
      appNodeId: entry.appNodeId,
      shareId: entry.shareId ?? null,
      contactId: entry.contactId ?? null,
      actorId: entry.actorId ?? null,
      kind: entry.kind,
      detail: entry.detail ?? {},
    })
    .catch(() => {
      /* best-effort — never block the visitor on audit */
    });
}

export type AppAccessRow = {
  id: string;
  contactId: string | null;
  /** Who, by name at read time: the contact's, or for a member login its
   *  display name (else the part of its email before the @); "Removed
   *  member" once that login is deleted. Null for anonymous (public)
   *  visitors or a since-deleted contact. */
  contactName: string | null;
  /** The member login, when a member ran the app from the member shell. */
  actorId: string | null;
  kind: AppAccessKind;
  detail: Record<string, unknown>;
  createdAt: string;
};

/** Recent external activity for one app, newest first (operator surface). The
 *  owner predicate is IN the WHERE (not a post-filter) so the LIMIT can never
 *  return fewer of the owner's own rows. Left-joins the contact node and the
 *  login for a display name. */
export async function listAppAccess(
  ownerId: string,
  appNodeId: string,
  limit = 100,
): Promise<AppAccessRow[]> {
  const rows = await db
    .select({
      id: appAccessLog.id,
      contactId: appAccessLog.contactId,
      contactName: nodes.title,
      actorId: appAccessLog.actorId,
      actorName: sql<
        string | null
      >`coalesce(nullif(trim(${authUsers.displayName}), ''), split_part(${authUsers.email}, '@', 1))`,
      kind: appAccessLog.kind,
      detail: appAccessLog.detail,
      createdAt: appAccessLog.createdAt,
    })
    .from(appAccessLog)
    .leftJoin(nodes, eq(nodes.id, appAccessLog.contactId))
    .leftJoin(authUsers, eq(authUsers.id, appAccessLog.actorId))
    .where(and(eq(appAccessLog.ownerId, ownerId), eq(appAccessLog.appNodeId, appNodeId)))
    .orderBy(desc(appAccessLog.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    // A member row whose login was deleted keeps no name (SET NULL): say so,
    // rather than let it read as an anonymous public visitor.
    contactName:
      r.contactName ??
      r.actorName ??
      (r.detail && (r.detail as { via?: unknown }).via === 'member' ? 'Removed member' : null),
    actorId: r.actorId,
    kind: r.kind as AppAccessKind,
    detail: r.detail,
    createdAt: r.createdAt.toISOString(),
  }));
}
