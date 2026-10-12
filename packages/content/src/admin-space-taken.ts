/**
 * Whom an admin took an item from (audit F07): the admin private-space list's
 * `takenFrom`. Take over and Give back were removed in workspaces W5c with
 * the rest of review; an item an admin took before that stays in their
 * private space (reviewState `taken`) until W6b moves personal items, and
 * the list still names its author. `canGiveBack` is always false now: there
 * is no Give back.
 *
 * Admin pool (asSystem): the space role reads no login row.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { asSystem, authUsers, db, nodes, spaceItems } from '@mantle/db';
import type { AdminTakenFrom } from '@mantle/client-types';

/**
 * For the taken items among `ids` in the admin's `spaceId`: who wrote each
 * one. Other ids are left out.
 */
export async function takenFromOf(
  spaceId: string,
  ids: readonly string[],
): Promise<Map<string, AdminTakenFrom>> {
  const out = new Map<string, AdminTakenFrom>();
  if (!ids.length) return out;
  const rows = await asSystem(
    () =>
      db
        .select({
          id: spaceItems.nodeId,
          loginId: authUsers.id,
          displayName: authUsers.displayName,
          email: authUsers.email,
          takenAt: spaceItems.takenAt,
        })
        .from(spaceItems)
        .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
        .leftJoin(authUsers, eq(authUsers.id, spaceItems.authorLoginId))
        .where(
          and(
            inArray(spaceItems.nodeId, [...ids]),
            eq(nodes.ownerId, spaceId),
            eq(spaceItems.reviewState, 'taken'),
          ),
        ),
    'space-taken-authors',
  );
  for (const r of rows) {
    out.set(r.id, {
      loginId: r.loginId ?? null,
      name: r.loginId
        ? r.displayName?.trim() || r.email?.split('@')[0] || 'A member'
        : 'Removed member',
      canGiveBack: false,
      takenAt: r.takenAt?.toISOString() ?? null,
    });
  }
  return out;
}
