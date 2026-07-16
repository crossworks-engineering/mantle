import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { nodeType } from './nodes';
import { mantlePeers } from './mantle-peers';

/**
 * Category-level grants: which whole node TYPES of mine a peer may read. A
 * scope row is a standing subscription resolved at query time — enable "page"
 * for a peer and every page, including pages created later, is readable by it.
 * This deliberately extends the trust model from "explicitly shared per node"
 * to "explicitly shared per node or per category"; the UI copy makes the
 * dynamic nature unmissable ("includes future pages").
 *
 * Which types may appear here is enforced in @mantle/content
 * (PEER_SHAREABLE_TYPES) — never secrets, mantle_peer, email, or journal.
 *
 * One active scope per (peer, type): revoking sets `revoked_at`, re-granting
 * mints a fresh row — the same revoke-don't-delete shape as `peer_shares`, so
 * grant history stays auditable.
 */
export const peerShareScopes = pgTable(
  'peer_share_scopes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    peerId: uuid('peer_id')
      .notNull()
      .references(() => mantlePeers.id, { onDelete: 'cascade' }),
    nodeType: nodeType('node_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('peer_share_scopes_peer_idx').on(t.peerId),
    uniqueIndex('peer_share_scopes_peer_type_active_uq')
      .on(t.peerId, t.nodeType)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export type PeerShareScope = typeof peerShareScopes.$inferSelect;
export type NewPeerShareScope = typeof peerShareScopes.$inferInsert;
