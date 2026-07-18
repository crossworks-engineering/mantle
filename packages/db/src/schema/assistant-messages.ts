import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { nodes } from './nodes';

/** Which transport a conversation turn arrived/left on. The conversation
 *  itself is per (owner, agent); the channel is just provenance + the hint
 *  for which transport sends an outbound reply. New channels (whatsapp, …)
 *  extend this union — see docs/conversation.md.
 *
 *  'web' vs 'mobile': both are the same HTTP surface (`/api/assistant/turn`),
 *  distinguished by auth — a session cookie is 'web' (browser), a mobile
 *  bearer token is 'mobile' (the companion app). The split lets proactive
 *  delivery (reminders) follow the last channel the user actually used; a
 *  browser can't receive an out-of-band push, the app can. See
 *  docs/reminder-delivery-routing.md. */
export type ConversationChannel = 'web' | 'telegram' | 'whatsapp' | 'mobile';

/** A media payload attached to a turn. Maps onto the `/assistant`
 *  ArtifactView render shape (audio → player, image → preview). `nodeId`
 *  points at the backing file node when one exists; `fileId` is the
 *  transport's own handle (e.g. a Telegram file_id) used to fetch bytes. */
export type ConversationAttachment = {
  kind: 'image' | 'audio' | 'voice' | 'document' | 'video';
  mime?: string;
  caption?: string;
  nodeId?: string;
  fileId?: string;
  url?: string;
};

/** Back-reference to the originating transport row, so an outbound reply can
 *  thread correctly and so a turn can be deduped/linked without a join table.
 *  All fields optional — web turns carry none. */
export type ConversationExternalRef = {
  accountId?: string;
  chatId?: string;
  messageId?: string;
  updateId?: number;
};

/**
 * Web assistant chat surface. One row per turn (inbound or outbound).
 * One continuous conversation **per (owner, agent)** — each agent has its
 * own forever-thread, no sessions / no thread switcher. The "same mind"
 * is shared (nodes / facts / entities aren't agent-partitioned), but the
 * conversation transcripts are strictly per-agent.
 *
 * Mirror of `telegram_messages` minus the transport-specifics; sharing
 * a shape across surfaces keeps the responder's prompt-building pipeline
 * reusable.
 *
 * `agent_id` is nullable again since migration 0127: the FK's ON DELETE SET
 * NULL is how a deleted agent orphans-but-preserves its archive (recall +
 * digests read it), and 0049's NOT NULL contradicted that — deleting any
 * agent with chat history 500'd. The runtime always stamps agent_id on
 * insert, so NULL only ever means "this agent was deleted"; the pre-0049
 * fold-in bug (NULL rows matching every agent's thread) was wildcard-matching
 * CODE, extinct — every reader filters by a concrete agent id.
 */
export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    direction: text('direction').notNull(), // 'inbound' | 'outbound' (CHECK enforced in SQL)
    text: text('text').notNull(),
    // Nullable BY DESIGN (0127): NULL = the authoring agent was deleted; the
    // runtime always stamps it on insert. Keep in step with the FK action.
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    model: text('model'),
    digestNodeId: uuid('digest_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    /** Transport this turn arrived/left on. Defaults to 'web' so pre-unification
     *  rows (all web) classify correctly with no backfill. See docs/conversation.md. */
    channel: text('channel').$type<ConversationChannel>().default('web').notNull(),
    /** Media payloads (images, voice notes) so non-web turns render in /assistant. */
    attachments: jsonb('attachments')
      .$type<ConversationAttachment[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    /** Back-reference to the originating transport row (Telegram chat/message ids,
     *  etc.) for reply threading + dedup. NULL for web turns. */
    externalRef: jsonb('external_ref').$type<ConversationExternalRef>(),
    data: jsonb('data')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    /** RESERVED execution-state projection. Not yet written: the current durable
     *  runner runs the turn and the web route AWAITS its result, so a failure
     *  surfaces synchronously (getResult rejects → the client shows the error)
     *  and every row is 'complete'. These columns are the UI-facing projection
     *  for the planned async-delivery model (route returns 202; the runner
     *  creates the outbound row 'pending' — the durable "thinking…" bubble — then
     *  flips it to 'complete' or 'failed'), where in-progress/failed states must
     *  survive navigation. Defaulting to 'complete' classifies all existing rows
     *  with no backfill (same trick as `channel`). DBOS WorkflowStatus is the
     *  execution source of truth; this is the read-model. See docs/conversation.md
     *  + the dedicated-API Phase 1 plan. */
    status: text('status').$type<'pending' | 'complete' | 'failed'>().default('complete').notNull(),
    /** Reserved (see `status`): human-readable failure reason for a 'failed'
     *  turn under the future async-delivery model; NULL today. */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('assistant_messages_owner_created_idx').on(t.ownerId, t.createdAt),
    // Drives the per-agent transcript query in recentAssistantMessages.
    index('assistant_messages_owner_agent_created_idx').on(t.ownerId, t.agentId, t.createdAt),
    // Per-agent, per-channel slice (e.g. "this agent's Telegram turns") for the
    // unified-stream reads + channel-filtered queries. See docs/conversation.md.
    index('assistant_messages_owner_agent_channel_created_idx').on(
      t.ownerId,
      t.agentId,
      t.channel,
      t.createdAt,
    ),
  ],
);

export type AssistantMessage = typeof assistantMessages.$inferSelect;
export type NewAssistantMessage = typeof assistantMessages.$inferInsert;
