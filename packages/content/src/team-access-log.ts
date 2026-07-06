/**
 * Audit writes for the external Team Chat surface (/team + /api/team/*). One
 * row per member action: token auth, chat turn, bearer API call, or a denied
 * attempt. The `app_access_log` pattern, brain-level instead of per-app.
 *
 * Fire-and-forget by design: `recordTeamAccess` swallows failures so an audit
 * hiccup can never take the chat surface down for a member. Best-effort trail,
 * not a gate — the gate is the per-request `isTeamMember` liveness check.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db, teamAccessLog, nodes } from '@mantle/db';

export type TeamAccessKind = 'auth' | 'turn' | 'api' | 'denied';

export type TeamAccessEntry = {
  ownerId: string;
  contactId?: string | null;
  kind: TeamAccessKind;
  detail?: Record<string, unknown>;
};

export function recordTeamAccess(entry: TeamAccessEntry): void {
  void db
    .insert(teamAccessLog)
    .values({
      ownerId: entry.ownerId,
      contactId: entry.contactId ?? null,
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
  kind: TeamAccessKind;
  detail: Record<string, unknown>;
  createdAt: string;
};

/** Recent team-surface activity, newest first — the whole brain or one
 *  member. Owner predicate is IN the WHERE so LIMIT never under-returns. */
export async function listTeamAccess(
  ownerId: string,
  opts: { contactId?: string; limit?: number } = {},
): Promise<TeamAccessRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const conds = [eq(teamAccessLog.ownerId, ownerId)];
  if (opts.contactId) conds.push(eq(teamAccessLog.contactId, opts.contactId));
  const rows = await db
    .select({
      id: teamAccessLog.id,
      contactId: teamAccessLog.contactId,
      contactName: nodes.title,
      kind: teamAccessLog.kind,
      detail: teamAccessLog.detail,
      createdAt: teamAccessLog.createdAt,
    })
    .from(teamAccessLog)
    .leftJoin(nodes, eq(nodes.id, teamAccessLog.contactId))
    .where(and(...conds))
    .orderBy(desc(teamAccessLog.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    contactName: r.contactName ?? null,
    kind: r.kind as TeamAccessKind,
    detail: r.detail,
    createdAt: r.createdAt.toISOString(),
  }));
}
