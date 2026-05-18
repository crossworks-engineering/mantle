import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { apiKeys } from './api-keys';

/**
 * `assistant`  — interactive chat surfaces (web /assistant, future voice).
 * `responder`  — async reply agents (Telegram DMs, email, …).
 * `extractor`  — structured extraction from ingested content.
 * `summarizer` — Tier-2 rollup / summary generation.
 * `reflector`  — slow background pass: appends to persona_notes from dialog signals.
 * `custom`     — anything that doesn't fit above.
 */
export const agentRole = pgEnum('agent_role', [
  'assistant',
  'responder',
  'extractor',
  'summarizer',
  'reflector',
  'custom',
]);

export type AgentMemoryConfig = {
  /** Max prior turns to replay into prompt. Default 20. */
  history_limit?: number;
  /** Optional time-window cap (hours). null = count-only. */
  history_window_hours?: number | null;
  /** Responder-only: how many recent digest nodes to prepend as Tier-2 context.
   *  Default 3. */
  digest_limit?: number;
  /** Responder-only: how many top-K facts to inject. Default 10. */
  fact_limit?: number;
  /** Responder-only: how many content_index hits to inject. Default 3. */
  content_hit_limit?: number;
  /** Summarizer-only: undigested-turn count that triggers a summarization.
   *  Default 30. */
  summarize_threshold?: number;
  /** Summarizer-only: how many of the oldest undigested turns to fold into
   *  one digest per run. Default 20. */
  summarize_batch?: number;
  /** Extractor-only: which node types the extractor processes. Default ['note'].
   *  Expand as we approve more types (email, file, sermon, …). */
  extract_types?: string[];
  /** Extractor-only: whether to extract facts in addition to summary+embedding.
   *  Default true. False = content_index population only. */
  extract_facts?: boolean;
};

export type AgentParams = {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
};

/**
 * One note appended by the reflector. `style` shapes voice/format,
 * `relationship` records corrections + personal calibrations,
 * `correction` is when the user explicitly flagged a mistake.
 */
export type PersonaNote = {
  kind: 'style' | 'relationship' | 'correction';
  content: string;
  at: string; // ISO timestamp
  source?: { type: 'turn' | 'digest'; id: string };
};

/**
 * One row per AI agent. The Telegram responder, the web assistant, future
 * extractors and summarizers all live here. `priority` decides who wins when
 * two enabled agents share a role.
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    role: agentRole('role').default('custom').notNull(),
    /** OpenRouter slug e.g. `anthropic/claude-sonnet-4.6`. */
    model: text('model').notNull(),
    /** Which entry in api_keys to use. SET NULL on key delete, not cascade. */
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    systemPrompt: text('system_prompt').notNull(),
    /** Allowlist of MCP tool names. Unused in v1. */
    tools: jsonb('tools').$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    memoryConfig: jsonb('memory_config').$type<AgentMemoryConfig>().default(sql`'{}'::jsonb`).notNull(),
    params: jsonb('params').$type<AgentParams>().default(sql`'{}'::jsonb`).notNull(),
    /** Reflector appends notes here. */
    personaNotes: jsonb('persona_notes').$type<PersonaNote[]>().default(sql`'[]'::jsonb`).notNull(),
    /** Higher = wins. Convention: 100 default. */
    priority: integer('priority').default(100).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    usageCount: bigint('usage_count', { mode: 'number' }).default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('agents_owner_slug_uq').on(t.ownerId, t.slug),
    index('agents_owner_role_priority_idx').on(t.ownerId, t.role, t.priority),
  ],
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
