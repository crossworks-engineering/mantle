import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * The transport types a channel can carry. Telegram is the only one wired
 * today; `discord` / `slack` are added in their own enum-add migrations when
 * their pollers ship (see docs/comms-channels.md §6/§9).
 */
export const channelType = pgEnum('channel_type', ['telegram']);

/**
 * A **channel** attaches a transport (Telegram, later Discord/Slack) to ANY
 * agent — decoupling transport from `agents.role` (docs/comms-channels.md).
 * Any agent can carry zero or more channels; whether an agent is "on Telegram"
 * is simply whether it has an enabled `type='telegram'` channel.
 *
 * Transport-specific *poll state* still lives in its own extension table
 * (`telegram_accounts`, 1:1 via `telegram_accounts.channel_id`); `channels`
 * stays transport-clean. The sealed credential (the bot token) lives here in
 * `credentials_enc`, AAD-bound to `channels.id` — the single home post-cutover.
 */
export const channels = pgTable(
  'channels',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    /** The agent this transport is attached to. Cascade-deletes the channel
     *  when the agent is removed (the binding is meaningless without it). */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    type: channelType('type').notNull(),
    /** Human label, e.g. '@saskianewbot'. */
    displayName: text('display_name').notNull(),
    /** Sealed transport secret (AES-GCM, MANTLE_MASTER_KEY). AAD = this row's
     *  id — re-seal (never raw-copy) if the row ever moves. */
    credentialsEnc: bytea('credentials_enc').notNull(),
    /** Non-secret transport config, e.g. { bot_username, branch_path }. */
    config: jsonb('config')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('channels_owner_idx').on(t.ownerId),
    index('channels_agent_idx').on(t.agentId),
    // An agent carries at most one channel of a given transport type (one
    // Telegram bot per agent; a Discord channel later is a distinct type).
    uniqueIndex('channels_agent_type_uq').on(t.agentId, t.type),
  ],
);

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
