import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Stored API keys for external services (OpenRouter, OpenAI, Anthropic, …).
 * Encrypted at rest via @mantle/crypto; AAD is the row id, so a ciphertext
 * cannot be lifted from one row and pasted into another.
 *
 * The plaintext is only surfaced to the UI twice: at create time and at
 * rotation. The list endpoint returns a masked view (first 4 + last 4 chars).
 *
 * Uniqueness is (user_id, service, label) so you can have multiple keys per
 * service (e.g. `openrouter:personal` and `openrouter:agent`).
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id').notNull(),
    service: text('service').notNull(),
    label: text('label').notNull().default('default'),
    keyEnc: bytea('key_enc').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    /** Precomputed first-4 + last-4 of the plaintext, set at create
     *  and rotate. Lets list views render without decrypting every row. */
    masked: text('masked').notNull().default('••••'),
    scopes: text('scopes')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    lastUsed: timestamp('last_used', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('api_keys_user_idx').on(t.userId),
    index('api_keys_service_idx').on(t.service),
    uniqueIndex('api_keys_user_service_label_uq').on(t.userId, t.service, t.label),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
