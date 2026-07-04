import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * Team-member tokens for contacts. A live row here IS the "team member" role —
 * there is deliberately no duplicate flag on the contact node, so membership
 * has a single source of truth. Delete the row and the contact is no longer a
 * team member; their token dies with it.
 *
 * The token itself is a short human-typeable secret (e.g. `Akk34DM…`) handed to
 * the contact out-of-band. Only its SHA-256 hex lands in `token_hash` — the
 * plaintext is shown once at mint and never stored. Rotating updates the hash
 * in place (same row, same membership, new secret).
 *
 * Consumers (the `/s/` app-share surface, Phase B) authenticate a visitor by
 * hashing the presented token and looking it up here; `last_used_at` gives the
 * operator a liveness signal on the contact detail screen.
 *
 * One live token per contact (`contact_id` unique). Owner-scoped like
 * everything else; the FK to `nodes` cascades so deleting a contact revokes
 * their token automatically.
 */
export const contactTeamTokens = pgTable(
  'contact_team_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the plaintext token. Unique so verify is a single indexed lookup. */
    tokenHash: text('token_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('contact_team_tokens_contact_idx').on(t.contactId),
    uniqueIndex('contact_team_tokens_hash_idx').on(t.tokenHash),
    index('contact_team_tokens_owner_idx').on(t.ownerId),
  ],
);

export type ContactTeamToken = typeof contactTeamTokens.$inferSelect;
export type NewContactTeamToken = typeof contactTeamTokens.$inferInsert;
