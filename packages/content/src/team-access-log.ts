/**
 * Audit writes for the team surfaces: a member login's chat turns and denials,
 * the invite redeem, and (history) the retired team-code portal's token auth,
 * chat turns and bearer calls. The `app_access_log` pattern, brain-level
 * instead of per-app.
 *
 * Fire-and-forget by design: `recordTeamAccess` swallows failures so an audit
 * hiccup can never take the chat surface down for a member. Best-effort trail,
 * not a gate.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, systemDb, teamAccessLog, nodes } from '@mantle/db';

export type TeamAccessKind = 'auth' | 'turn' | 'api' | 'denied';

export type TeamAccessEntry = {
  ownerId: string;
  contactId?: string | null;
  /** The member login acting (0175). */
  loginId?: string | null;
  kind: TeamAccessKind;
  detail?: Record<string, unknown>;
};

export function recordTeamAccess(entry: TeamAccessEntry): void {
  // systemDb: an access record is written even under a limited viewer role.
  void systemDb
    .insert(teamAccessLog)
    .values({
      ownerId: entry.ownerId,
      contactId: entry.contactId ?? null,
      loginId: entry.loginId ?? null,
      kind: entry.kind,
      detail: entry.detail ?? {},
    })
    .catch(() => {
      /* best-effort — never block a member on audit */
    });
}

export type TeamAccessRow = {
  id: string;
  contactId: string | null;
  /** Resolved at read time; null once the contact is deleted (rows outlive
   *  the person by design). */
  contactName: string | null;
  /** The member login the event belongs to: its own events, and the portal
   *  history of the contact it was invited from (0175). */
  loginId: string | null;
  kind: TeamAccessKind;
  detail: Record<string, unknown>;
  createdAt: string;
};

/** Recent team-surface activity, newest first: the whole brain, one
 *  contact, or one member login (both filters AND). Owner predicate is IN the
 *  WHERE so LIMIT never under-returns. */
export async function listTeamAccess(
  ownerId: string,
  opts: {
    contactId?: string;
    loginId?: string;
    limit?: number;
    /** false: the log rows alone, contactName null: the
     *  caller resolves the contact names in its own scope, so a read of the
     *  log on the system pool reads no item. */
    names?: boolean;
  } = {},
): Promise<TeamAccessRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const conds = [eq(teamAccessLog.ownerId, ownerId)];
  if (opts.contactId) conds.push(eq(teamAccessLog.contactId, opts.contactId));
  if (opts.loginId) conds.push(eq(teamAccessLog.loginId, opts.loginId));
  const cols = {
    id: teamAccessLog.id,
    contactId: teamAccessLog.contactId,
    loginId: teamAccessLog.loginId,
    kind: teamAccessLog.kind,
    detail: teamAccessLog.detail,
    createdAt: teamAccessLog.createdAt,
  };
  const rows =
    opts.names === false
      ? (
          await db
            .select(cols)
            .from(teamAccessLog)
            .where(and(...conds))
            .orderBy(desc(teamAccessLog.createdAt))
            .limit(limit)
        ).map((r) => ({ ...r, contactName: null as string | null }))
      : await db
          .select({ ...cols, contactName: nodes.title })
          .from(teamAccessLog)
          .leftJoin(nodes, eq(nodes.id, teamAccessLog.contactId))
          .where(and(...conds))
          .orderBy(desc(teamAccessLog.createdAt))
          .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    contactName: r.contactName ?? null,
    loginId: r.loginId,
    kind: r.kind as TeamAccessKind,
    detail: r.detail,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * The titles of the contacts `ids` the current caller reads, by id. Run in
 * the caller's scope: the owner-side team tools read their
 * logs and threads (system tables) through the system pool and name the
 * contacts here, so no contact is read on the system pool. A contact the
 * scope does not read, or a deleted one, is absent.
 */
export async function contactTitles(
  ownerId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map();
  const rows = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact'), inArray(nodes.id, list)));
  return new Map(rows.map((r) => [r.id, r.title ?? '']));
}
