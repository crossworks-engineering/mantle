/**
 * The `space_item_changed` realtime event (member logins Phase 2, plan v3.1
 * section 2d): a personal item was created, saved, shared or unshared,
 * submitted or recalled, deleted, or its comment thread changed.
 *
 * Raised by the personal-space functions themselves, inside the caller's
 * transaction, so it is delivered on commit and never for a write that
 * rolled back. The payload carries ids and flags only, never content; the
 * member SSE route passes an event to a member when the item is in their own
 * space or is (or just was) shared with the team, and the client reloads.
 * Notify-only: nothing here can reach an LLM.
 */
import { eq, sql } from 'drizzle-orm';
import { db, nodes, spaceItems } from '@mantle/db';

export const SPACE_ITEM_CHANGED_CHANNEL = 'space_item_changed';

export type SpaceItemChangeKind = 'created' | 'saved' | 'state' | 'deleted' | 'comment';

export type SpaceItemChange = {
  id: string;
  spaceId: string;
  kind: SpaceItemChangeKind;
  /** Shared with the team now, or just before this change (an unshare or a
   *  delete must reach the teammates who were showing it). */
  team: boolean;
};

/** Parse a NOTIFY payload; null when it is not one of ours. */
export function parseSpaceItemChange(payload: string): SpaceItemChange | null {
  try {
    const c = JSON.parse(payload) as Partial<SpaceItemChange>;
    if (typeof c.id !== 'string' || typeof c.spaceId !== 'string') return null;
    return {
      id: c.id,
      spaceId: c.spaceId,
      kind: (c.kind ?? 'saved') as SpaceItemChangeKind,
      team: c.team === true,
    };
  } catch {
    return null;
  }
}

/**
 * Announce a change. `known` skips the lookup (a delete announces from the
 * row it read before the row went away; a share change passes the sharing it
 * replaced). Best effort by design: a missed event costs a manual reload.
 * The lookup runs in the caller's scope, which can always see the item it is
 * changing.
 */
export async function notifySpaceItemChanged(
  id: string,
  kind: SpaceItemChangeKind,
  known?: { spaceId: string; team: boolean },
): Promise<void> {
  let change: SpaceItemChange | null = known ? { id, kind, ...known } : null;
  if (!change) {
    const [r] = await db
      .select({ spaceId: nodes.ownerId, sharing: spaceItems.sharing })
      .from(nodes)
      .leftJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
      .where(eq(nodes.id, id))
      .limit(1);
    if (!r) return;
    change = { id, kind, spaceId: r.spaceId, team: r.sharing === 'team' };
  }
  await db.execute(sql`SELECT pg_notify(${SPACE_ITEM_CHANGED_CHANNEL}, ${JSON.stringify(change)})`);
}
