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
  /** Extractor-only: hard ceiling on per-run LLM spend in micro-USD (10⁻⁶ USD).
   *  Once the current trace's accumulated cost crosses this, the fact-processing
   *  loop bails gracefully (mid-iteration). Null/undefined = no cap. The
   *  initial llm_extract call is allowed to overshoot — the cap is checked
   *  per-iteration in the classifier loop. */
  extract_cost_cap_micro_usd?: number | null;
  /** Embedding model override. Falls back to MANTLE_EMBEDDING_MODEL env,
   *  then to `openai/text-embedding-3-small`. Applies wherever this agent
   *  calls embed() — extractor writes vectors, responder/assistant read
   *  query vectors. For retrieval to work, the extractor's model must
   *  match the responder/assistant's — vectors from different models live
   *  in different spaces and don't compare. Allowed values must output
   *  1536-dim vectors (the `nodes.embedding` column shape). */
  embedding_model?: string;
  /** Agent slugs this agent is allowed to invoke via the `invoke_agent`
   *  builtin. Empty/missing means no delegation permitted (fail closed).
   *  Self-references are refused at dispatch time. The depth chain is
   *  also capped — see MAX_AGENT_DEPTH in @mantle/tools. */
  delegate_to?: string[];
};

export type AgentParams = {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  /** Voice-reply config. Used by `apps/agent` when an inbound message
   *  came in as a Telegram voice note: the agent's reply gets piped
   *  through OpenAI TTS and sent as `sendVoice` instead of plain text.
   *  All fields optional — sensible defaults applied at the call site
   *  (`nova` voice, `tts-1` model, 1.0× speed). Set `enabled: false`
   *  to keep text replies even when the user voice-messages. */
  voice?: {
    /** Defaults to true: voice in → voice out. */
    enabled?: boolean;
    /** OpenAI voice name. See @mantle/voice TTS_VOICES. */
    name?: 'alloy' | 'echo' | 'fable' | 'nova' | 'onyx' | 'shimmer';
    /** `tts-1` is fast/cheap; `tts-1-hd` is ~2× cost for slightly
     *  higher fidelity. */
    model?: 'tts-1' | 'tts-1-hd';
    /** Playback speed multiplier 0.25–4.0. 1.0 is natural; 0.95 sounds
     *  a touch more conversational. */
    speed?: number;
  };
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
    /** Legacy free-form MCP tool name array. Superseded by `tool_slugs` /
     *  `skill_slugs` below; kept for back-compat with existing rows. */
    tools: jsonb('tools').$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    /** Slugs of `tools` rows this agent may call during a turn. The runtime
     *  unions this with the toolSlugs of every attached skill. */
    toolSlugs: text('tool_slugs').array().default(sql`'{}'::text[]`).notNull(),
    /** Slugs of `skills` rows attached to this agent. Instructions are
     *  always-loaded into the system prompt (v1 activation model). */
    skillSlugs: text('skill_slugs').array().default(sql`'{}'::text[]`).notNull(),
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
