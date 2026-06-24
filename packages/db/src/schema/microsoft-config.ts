import { sql } from 'drizzle-orm';
import { customType, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * The Azure AD app registration this brain uses for Microsoft Graph OAuth, set
 * from the UI instead of editing `.env` + restarting. Singleton per owner
 * (`owner_id` unique), mirroring `tailscale_config` / `embedding_config`.
 *
 * The client secret is sealed at rest via @mantle/crypto with the row id as AAD
 * (same as `api_keys` / `tailscale_config`); the UI only ever sees `masked`.
 * The client id, tenant, and redirect URI are not secret and stay plaintext.
 *
 * Resolution precedence (see @mantle/microsoft config-store): this row wins;
 * if absent or incomplete, the loader falls back to `MS_CLIENT_ID` /
 * `MS_CLIENT_SECRET` / `MS_TENANT` / `MS_REDIRECT_URI` env so pre-existing
 * env-configured deployments keep working unchanged.
 */
export const microsoftConfig = pgTable('microsoft_config', {
  /** One row per owner — the singleton key. */
  ownerId: uuid('owner_id').primaryKey(),
  clientId: text('client_id').notNull(),
  clientSecretEnc: bytea('client_secret_enc').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  /** First-4 + last-4 of the secret, set on save so the UI renders without
   *  decrypting. */
  secretMasked: text('secret_masked').notNull().default('••••'),
  /** Authority tenant segment: `common` (any org + personal), `organizations`,
   *  or a specific tenant id. */
  tenant: text('tenant').notNull().default('common'),
  /** The exact redirect URI registered on the Azure app. Stored so authorize +
   *  callback use a byte-identical value (Azure matches it exactly). */
  redirectUri: text('redirect_uri').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type MicrosoftConfigRow = typeof microsoftConfig.$inferSelect;
export type NewMicrosoftConfigRow = typeof microsoftConfig.$inferInsert;
