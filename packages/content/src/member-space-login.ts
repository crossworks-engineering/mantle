/**
 * What a change to a login does to its personal space (audit F21).
 *
 * A member promoted to admin keeps their space (every login has one), but an
 * admin's items are never team drafts and never reviewed (Phase 7). The rows
 * of what they shared or submitted as a member would otherwise sit there:
 * hidden while they are an admin, back in Team drafts after a demotion. So a
 * promotion turns them back into private drafts, in the promotion's own
 * transaction: 'team' becomes 'private', 'submitted' becomes 'draft' (the
 * admin can edit it again; there is no admin Recall), and the recorded
 * bundles go. Migration 0180 did the same once for the admins of the day.
 *
 * A DELETED login needs nothing here: its space counts as nobody's member
 * space from then on (`mantle_member_space`, 0180), and the purge takes its
 * private items 30 days after `spaces.orphaned_at`.
 *
 * Row writes and change events only, on the caller's admin-pool transaction.
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { db, nodes, spaceItems, spaces } from '@mantle/db';
import { clearBundles } from './member-bundle';
import { notifySpaceItemChanged } from './member-space-events';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Turn the promoted login's shared and submitted items back into private
 * drafts. Idempotent (a second call finds nothing). Returns how many items
 * changed.
 */
export async function settleSpaceOnPromotion(tx: Tx, loginId: string): Promise<number> {
  const rows = await tx
    .select({ id: spaceItems.nodeId, spaceId: nodes.ownerId, sharing: spaceItems.sharing })
    .from(spaceItems)
    .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
    .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
    .where(
      and(
        eq(spaces.kind, 'personal'),
        eq(spaces.loginId, loginId),
        or(eq(spaceItems.sharing, 'team'), eq(spaceItems.reviewState, 'submitted')),
      ),
    )
    .for('update', { of: spaceItems });
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const now = new Date();
  await tx
    .update(spaceItems)
    .set({ sharing: 'private', updatedAt: now })
    .where(and(inArray(spaceItems.nodeId, ids), eq(spaceItems.sharing, 'team')));
  await tx
    .update(spaceItems)
    .set({ reviewState: 'draft', submittedAt: null, updatedAt: now })
    .where(and(inArray(spaceItems.nodeId, ids), eq(spaceItems.reviewState, 'submitted')));
  await clearBundles(tx, ids);
  // Teammates' views drop what was shared; nothing else listens.
  for (const r of rows) {
    await notifySpaceItemChanged(
      r.id,
      'state',
      { spaceId: r.spaceId, team: r.sharing === 'team' },
      tx,
    );
  }
  return rows.length;
}
