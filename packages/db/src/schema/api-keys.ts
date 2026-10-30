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
    /** Anthropic only: the workspace id a key not scoped to a workspace
     *  names on every call (`anthropic-workspace-id`, sent by the adapter's
     *  anthropicHeaders). Not secret; null = none (0292). */
    anthropicWorkspaceId: text('anthropic_workspace_id'),
    scopes: text('scopes')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    /** Credential vault v2 (0346): token (every row before it), password,
     *  ssh_key or login. Only a token is opened by the read paths
     *  (@mantle/api-keys); another kind waits for the use gateway. */
    kind: text('kind').$type<VaultKind>().notNull().default('token'),
    /** What agents say: the service when the label is 'default', else
     *  service/label. Generated, unique per owner (0346). */
    name: text('name').generatedAlwaysAs(
      sql`CASE WHEN "label" = 'default' THEN "service" ELSE "service" || '/' || "label" END`,
    ),
    /** Hosts or web origins the secret may be used on; empty = a provider
     *  key, as before 0346. */
    target: text('target')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    /** Sealed JSON of a many-field kind (user, passphrase, sudo password,
     *  port), AAD `<id>:fields`. Null for a token. */
    fieldsEnc: bytea('fields_enc'),
    /** SSH only: the pinned server key (vault part 3). */
    hostKey: text('host_key'),
    /** Each use waits for the owner (vault part 2). */
    needsApproval: boolean('needs_approval').notNull().default(false),
    tags: text('tags')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    viaTailnet: boolean('via_tailnet').notNull().default(false),
    useCount: integer('use_count').notNull().default(0),
    lastUsed: timestamp('last_used', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('api_keys_user_idx').on(t.userId),
    index('api_keys_service_idx').on(t.service),
    uniqueIndex('api_keys_user_service_label_uq').on(t.userId, t.service, t.label),
    uniqueIndex('api_keys_user_name_uq').on(t.userId, t.name),
  ],
);

/** The kinds of secret the vault holds (0346 api_keys_kind_chk). */
export const VAULT_KINDS = ['token', 'password', 'ssh_key', 'login'] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
