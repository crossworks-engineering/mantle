import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { nodes } from './nodes';
import type { ConversationAttachment } from './assistant-messages';

/** Transport a team turn arrived/left on. 'web' = the /team surface; 'api' =
 *  a bearer-token client hitting /api/team/* directly; 'msteams' = the future
 *  MS Teams adapter (which is just an 'api' client that tags itself). */
export type TeamChannel = 'web' | 'api' | 'msteams';

/**
 * Team Chat surface. One row per turn (inbound or outbound), one continuous
 * conversation **per (owner, contact)** — each team member has their own
 * forever-thread with the brain's team responder, mirroring the per-agent
 * forever-thread model of `assistant_messages`. Deliberately a separate table:
 * the owner's conversation stream never mixes with external members' turns.
 *
 * `contact_id` CASCADEs — deleting a contact is revocation, and the thread
 * goes with the person; the audit trail survives in `team_access_log` (SET
 * NULL) and `traces`. `trace_id` on outbound rows deep-links the turn's full
 * tool-call record for the admin view.
 */
export const teamMessages = pgTable(
  'team_messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    direction: text('direction').notNull(), // 'inbound' | 'outbound' (CHECK enforced in SQL)
    text: text('text').notNull(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    model: text('model'),
    channel: text('channel').$type<TeamChannel>().default('web').notNull(),
    /** Same shape as assistant_messages.attachments so the responder's
     *  prompt-building pipeline stays reusable. */
    attachments: jsonb('attachments')
      .$type<ConversationAttachment[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    /** The turn's trace (kind 'responder_turn', subject_kind 'team_turn') —
     *  the admin's deep link from a reply to what the brain actually did. */
    traceId: uuid('trace_id'),
    status: text('status')
      .$type<'pending' | 'complete' | 'failed'>()
      .default('complete')
      .notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Drives the per-contact transcript query (member view + context loader).
    index('team_messages_thread_idx').on(t.ownerId, t.contactId, t.createdAt),
    // Drives the admin member-index "recent activity" ordering.
    index('team_messages_recent_idx').on(t.ownerId, t.createdAt.desc()),
  ],
);

export type TeamMessage = typeof teamMessages.$inferSelect;
export type NewTeamMessage = typeof teamMessages.$inferInsert;
