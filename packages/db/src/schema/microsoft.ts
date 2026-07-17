import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  jsonb,
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
 * One row per connected Microsoft identity (delegated OAuth). The Azure app
 * registration is shared per-deployment (env); the per-user tokens live here,
 * sealed with `@mantle/crypto` (AAD = row id, like `api_keys`).
 *
 * M0 establishes this table + the self-refreshing token lifecycle. The
 * per-surface sync state (drive delta links, mail delta link) is carried in
 * `syncState` jsonb and consumed by M1–M3 — see docs/microsoft-graph-ingest.md.
 */
export const msAccounts = pgTable(
  'ms_accounts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id').notNull(),
    /** User principal name / primary email of the signed-in MS account. */
    upn: text('upn').notNull(),
    displayName: text('display_name'),
    /** Home tenant id of the signed-in user (from the id token / Graph). */
    tenantId: text('tenant_id'),
    /** Sealed OAuth tokens (AES-256-GCM, AAD = this row's id). */
    accessTokenEnc: bytea('access_token_enc'),
    refreshTokenEnc: bytea('refresh_token_enc'),
    /** Absolute access-token expiry; the refresh path triggers within a skew
     *  window of this. Plaintext so the worker can reason without unsealing. */
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    /** Scopes actually granted (space-split), for capability checks. */
    scopes: text('scopes')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    /** Stable ltree root this account's ingested content lands under. */
    branchPath: text('branch_path').notNull(),
    /** Which surfaces are enabled for sync, e.g. {drives,mail,calendar}.
     *  Empty until the user opts surfaces in (opt-in, like the email gate). */
    surfaces: jsonb('surfaces')
      .$type<Record<string, boolean>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    /** Per-surface sync cursors (drive delta links, mail delta link, …).
     *  Keyed like { "drive:<id>": "<deltaLink>", "mail": "<deltaLink>" }. */
    syncState: jsonb('sync_state')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('ms_accounts_user_idx').on(t.userId),
    uniqueIndex('ms_accounts_user_upn_uq').on(t.userId, t.upn),
  ],
);

export type MsAccount = typeof msAccounts.$inferSelect;
export type NewMsAccount = typeof msAccounts.$inferInsert;
