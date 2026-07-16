import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * A federated peer — another sovereign single-user Mantle we exchange scoped
 * data with. NOT multi-tenancy: two separate brains negotiating at the border.
 *
 * Each peer has two tokens, one per direction:
 *  - `outbound_token_enc` — the token THEY issued US, sealed AES-256-GCM
 *    (AAD = row id). We send it as `Authorization: Bearer` when we call their
 *    federation API. Reversible because we have to replay it. NULL while the
 *    pairing is half-done (status='pending'): the peer exists so our inbound
 *    token could be minted + handed over, but they haven't given us theirs yet.
 *  - `inbound_token_hash` — SHA-256 of the token WE minted for THEM. We show
 *    that token's plaintext to the operator exactly once (to hand to the peer)
 *    and keep only the hash; an inbound request is verified by hashing the
 *    presented bearer and matching. No reversible inbound secret at rest.
 *
 * The browsable face is a `nodes` row (type='mantle_peer') linked via node_id —
 * same split as telegram_accounts (sealed sidecar) vs. its node. Access a peer
 * gets is governed entirely by `peer_shares`; this row is just identity + auth.
 */
export const mantlePeers = pgTable(
  'mantle_peers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    /** Root of the peer's federation API, e.g. https://her-mantle.example.com */
    baseUrl: text('base_url').notNull(),
    outboundTokenEnc: bytea('outbound_token_enc'),
    outboundTokenVersion: integer('outbound_token_version').notNull().default(1),
    inboundTokenHash: text('inbound_token_hash').notNull(),
    /**
     * 'pending' | 'active' | 'revoked'. 'pending' = awaiting the peer's
     * outbound token: inbound requests verify, outbound calls are disabled.
     */
    status: text('status').notNull().default('active'),
    enabled: boolean('enabled').notNull().default(true),
    /** When we last successfully called the peer. */
    lastContactedAt: timestamp('last_contacted_at', { withTimezone: true }),
    /** When the peer last successfully called us. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('mantle_peers_owner_idx').on(t.ownerId),
    uniqueIndex('mantle_peers_inbound_hash_uq').on(t.inboundTokenHash),
    uniqueIndex('mantle_peers_node_uq').on(t.nodeId),
  ],
);

export type MantlePeer = typeof mantlePeers.$inferSelect;
export type NewMantlePeer = typeof mantlePeers.$inferInsert;
