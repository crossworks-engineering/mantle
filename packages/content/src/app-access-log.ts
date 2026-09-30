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
 *
 * Bounded (client tier audit 2026-09-30, I4): tool calls and writes land a
 * row each, but a caller's database READS at most one row per app per
 * minute (a running app polls), and the `app-access-log-reap` maintenance
 * sweep deletes rows older than APP_ACCESS_LOG_RETENTION_DAYS.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
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

/** A caller's database reads land at most one row per app this often. */
export const APP_ACCESS_QUERY_SAMPLE_MS = 60_000;
/** The access log keeps this many days (the `app-access-log-reap` sweep). */
export const APP_ACCESS_LOG_RETENTION_DAYS = 90;

/** When each caller's read of each app was last logged (this process). */
const lastQueryLogged = new Map<string, number>();

/** Whether this entry is a read that was already logged for the same caller
 *  and app within the last APP_ACCESS_QUERY_SAMPLE_MS. Refused reads, tool
 *  calls and writes are always logged. */
function readAlreadyLogged(entry: AppAccessEntry, now: number): boolean {
  const detail = entry.detail ?? {};
  if (entry.kind !== 'db' || detail.op !== 'query' || detail.refused) return false;
  const who = entry.actorId ?? (entry.shareId ? `share:${entry.shareId}` : (entry.contactId ?? ''));
  const key = `${entry.appNodeId}:${who}`;
  const last = lastQueryLogged.get(key);
  if (last !== undefined && now - last < APP_ACCESS_QUERY_SAMPLE_MS) return true;
  if (lastQueryLogged.size >= 10_000) {
    for (const [k, t] of lastQueryLogged) {
      if (now - t >= APP_ACCESS_QUERY_SAMPLE_MS) lastQueryLogged.delete(k);
    }
  }
  lastQueryLogged.set(key, now);
  return false;
}

export function recordAppAccess(entry: AppAccessEntry): void {
  if (readAlreadyLogged(entry, Date.now())) return;
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

/**
 * The reaper (maintenance sweep `app-access-log-reap`, plain SQL, no model):
 * deletes access log rows older than {@link APP_ACCESS_LOG_RETENTION_DAYS},
 * in batches so a first run on a big table holds no long lock. `dryRun`
 * counts without deleting. Idempotent.
 */
export async function reapAppAccessLog(
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<{ deleted: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - APP_ACCESS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  if (opts.dryRun) {
    const [row] = await systemDb
      .select({ n: sql<number>`count(*)::int` })
      .from(appAccessLog)
      .where(lt(appAccessLog.createdAt, cutoff));
    return { deleted: row?.n ?? 0 };
  }
  const BATCH = 10_000;
  let deleted = 0;
  for (;;) {
    const gone = (await systemDb.execute(sql`
      delete from app_access_log
       where id in (select id from app_access_log where created_at < ${cutoff.toISOString()}::timestamptz limit ${BATCH})
      returning id`)) as unknown as unknown[];
    deleted += gone.length;
    if (gone.length < BATCH) return { deleted };
  }
}
