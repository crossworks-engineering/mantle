import { sql } from 'drizzle-orm';
import { customType, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Secrets: AES-256-GCM ciphertext sealed by @mantle/crypto. The metadata
 * (title, branch, tags, embedding) lives on the parent `nodes` row so AI
 * can _find_ a secret without ever decrypting it. The plaintext only leaves
 * here when the user (or an explicitly-authorised AI call) opens it.
 */
export const secrets = pgTable('secrets', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  nodeId: uuid('node_id')
    .notNull()
    .unique()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  ciphertext: bytea('ciphertext').notNull(),
  keyVersion: integer('key_version').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;
