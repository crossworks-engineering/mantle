import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { nodes, nodeType } from './nodes';
import { mantlePeers } from './mantle-peers';

/**
 * Explicit per-node grants: which of MY nodes a given peer may read. This is
 * the entire access-control surface for federation — a peer's federation query
 * returns the intersection of (what it asked for) ∩ (nodes with an active grant
 * for that peer). Nothing is visible to a peer without a row here, so passports
 * stay invisible until deliberately shared.
 *
 * One active grant per (peer, node): revoking sets `revoked_at`, re-granting
 * mints a fresh row — the same revoke-don't-delete shape as public `shares`,
 * so the grant history stays auditable.
 */
export const peerShares = pgTable(
  'peer_shares',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    peerId: uuid('peer_id')
      .notNull()
      .references(() => mantlePeers.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    nodeType: nodeType('node_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('peer_shares_peer_idx').on(t.peerId),
    uniqueIndex('peer_shares_peer_node_active_uq')
      .on(t.peerId, t.nodeId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export type PeerShare = typeof peerShares.$inferSelect;
export type NewPeerShare = typeof peerShares.$inferInsert;
