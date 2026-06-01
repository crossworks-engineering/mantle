import { sql } from 'drizzle-orm';
import { customType, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * The owner's Tailscale auth key + device name, so the tailnet can be brought
 * up from the UI instead of editing the VPS `.env`. Singleton per owner
 * (`owner_id` unique). The auth key is sealed at rest via @mantle/crypto with
 * the row id as AAD — exactly like `api_keys` / `pdf_passwords` — so a
 * ciphertext can't be lifted from one row into another.
 *
 * The plaintext key is only ever read server-side to drive tailscaled's
 * LocalAPI login; the UI sees `masked` (first 4 + last 4) only.
 */
export const tailscaleConfig = pgTable(
  'tailscale_config',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull().unique(),
    authKeyEnc: bytea('auth_key_enc').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    /** Device name to register as on the tailnet (TS_HOSTNAME equivalent). */
    hostname: text('hostname').notNull().default('mantle'),
    /** Precomputed first-4 + last-4 of the key, set on save. Lets the UI render
     *  without decrypting. */
    masked: text('masked').notNull().default('••••'),
    /** Bumped each time the tailnet is activated from the UI. */
    lastActivatedAt: timestamp('last_activated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('tailscale_config_owner_idx').on(t.ownerId)],
);

export type TailscaleConfig = typeof tailscaleConfig.$inferSelect;
export type NewTailscaleConfig = typeof tailscaleConfig.$inferInsert;
