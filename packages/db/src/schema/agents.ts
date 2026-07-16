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

/** Avatar selection for an agent: a style id + seed (boring-avatars).
 *  Rendered on the fly in the UI (see apps/web/lib/avatar-svg.ts). Null =
 *  fall back to the derived initials/accent avatar. */
export type AgentAvatar = {
  style: string;
  seed: string;
};

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
  /** Responder-only: how many content_index hits to inject. Default 5. */
  content_hit_limit?: number;
  /** Responder-only: how many section-level passages (content_chunks) to inject.
   *  Default 3. These carry real passage text, so they're the priciest slice. */
  chunk_limit?: number;
  /** Responder-only: how many corpus-map entries (titles of the user's pages /
   *  tables / files / notes / tasks) to inject as a cached "what exists" index.
   *  Default 300; 0 disables the map. Titles-only lines are cheap (~15-25
   *  tokens each) and the block rides its own prompt-cache breakpoint, so it
   *  re-bills only when corpus content actually changes. */
  corpus_map_limit?: number;
  /** Responder/assistant-only: inject the always-on "who you are" identity
   *  block distilled from the user's Journal (see
   *  @mantle/content buildIdentityContext) into the cached system prompt.
   *  Default true for conversational agents (the whole point of Journal);
   *  set false on a utility/persona-light agent that shouldn't carry it.
   *  Deterministic, no LLM — a no-op when the user has no journal entries. */
  inject_journal?: boolean;
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
  // NOTE: there is no per-agent embedding_model. The embedder is the single
  // `embedding_config` row (migration 0061); agents display it, never set it.
  /** Agent slugs this agent is allowed to invoke via the `invoke_agent`
   *  builtin. Empty/missing means no delegation permitted (fail closed).
   *  Self-references are refused at dispatch time. The depth chain is
   *  also capped — see MAX_AGENT_DEPTH in @mantle/tools. */
  delegate_to?: string[];
  /** Override the tool-loop's MAX_ITERATIONS cap. Default in
   *  `runToolLoop` is 6 — enough for conversational turns where the
   *  model reads-then-replies, but too tight for batch-edit agents that
   *  read N blocks then write N blocks (which is N+overhead iterations).
   *  Pages sets this to ~20 so a 10-block edit completes cleanly without
   *  force_final eating its update phase. Bounded by the runtime at a
   *  hard ceiling so a misconfigured value can't hang the loop. */
  max_iterations?: number;
  /** Override the tool-loop's cumulative tool-call budget per turn (default
   *  40). Batch-edit agents legitimately spend more — a large page restructure
   *  is read + N updates + M deletes. Bounded by the runtime at a hard ceiling
   *  (200); caps are enforced at batch boundaries so write batches are never
   *  severed halfway. */
  max_tool_calls?: number;
  /** Override the same-tool fixation cap per turn (default 15). Raise for
   *  agents whose real workload is many calls of ONE tool (pages block edits).
   *  Runtime hard ceiling 100. */
  max_calls_per_tool?: number;
  /** Tool-result handling override (KB units). When a tool returns more than
   *  `inline_max_kb`, the full output is spilled to the tool-result store and
   *  the model gets a handle it pages/greps/queries via `read_result` instead
   *  of a truncated dump. `embed_min_kb` is where the spill envelope starts
   *  recommending semantic `query`. Both fall back to env/global defaults
   *  (TOOL_RESULT_*). Page size is global-only. See architecture §9l. */
  result_handling?: {
    inline_max_kb?: number;
    embed_min_kb?: number;
    /** Hard ceiling on stored result size; beyond it the output is
     *  head-truncated before spilling. Falls back to env TOOL_RESULT_SPILL_MAX. */
    spill_max_kb?: number;
  };
};

export type AgentParams = {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  /** Retries AFTER the first chat attempt on transient errors (429, 5xx,
   *  network blips, request timeout) with exponential backoff + jitter.
   *  Undefined ⇒ 2 (the chat adapter's default); 0 disables. Threaded into
   *  ChatOptions.maxRetries by the tool loop; honored by withChatRetry for
   *  direct-provider adapters (OpenRouter retries via its own SDK). */
  max_retries?: number;
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
 * One persona note. Written by the reflector (passive observation) or
 * the `update_persona` tool (explicit user instruction). `style` shapes
 * voice/format, `relationship` records personal calibrations,
 * `correction` is when the user explicitly flagged a mistake.
 *
 * Notes are soft-retired, never deleted: persona has no immutable source
 * underneath it (unlike conversation digests, which sit over raw turns),
 * so a bad edit must stay recoverable. The read path filters out anything
 * with `retiredAt`; retired notes linger as an audit tail.
 */
export type PersonaNote = {
  /** Stable id, assigned at creation. Legacy notes may lack it —
   *  addressing falls back to a content hash (see noteRef). */
  id?: string;
  kind: 'style' | 'relationship' | 'correction';
  content: string;
  at: string; // ISO timestamp
  source?: { type: 'turn' | 'digest'; id: string };
  /** Set when the note is superseded or removed. Read path filters these. */
  retiredAt?: string; // ISO
  retiredReason?: 'superseded' | 'removed';
  /** For retiredReason='superseded': the id of the replacing note. */
  supersededBy?: string;
};

/**
 * One row per AI agent. The Telegram responder, the web assistant, future
 * extractors and summarizers all live here. `priority` decides who wins when
 * two enabled agents share a role.
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    role: agentRole('role').default('custom').notNull(),
    /** Provider id matching `packages/voice/src/providers.ts`. Drives
     *  which chat adapter the responder / assistant / heartbeat loop
     *  resolves via getChatAdapter(provider). Defaults to 'openrouter'
     *  — the legacy hard-wired routing before Phase 3 added the column.
     *  Migration 0048 added the column with a backfilled 'openrouter'
     *  default; existing rows pre-migration are equivalent to a row
     *  explicitly carrying that value. */
    provider: text('provider').notNull().default('openrouter'),
    /** Model id, interpreted relative to `provider`. For OpenRouter
     *  this is a route slug (`anthropic/claude-sonnet-4.6`); for direct
     *  providers it's the bare id (`claude-sonnet-4-6`, `gpt-5`,
     *  `gemini-2.5-pro`). */
    model: text('model').notNull(),
    /** Which entry in api_keys to use. SET NULL on key delete, not cascade. */
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    /** Optional BACKUP chat route — same shape as the active (primary)
     *  provider/model/apiKeyId above. When `backupEnabled` and a route-DOWN /
     *  429 error hits the primary, the runtime fails over to this route. Unlike
     *  embeddings, a chat backup may be a DIFFERENT model (no vector-space
     *  lock) — that's what lets a local model be primary with a cloud backup.
     *  The "make backup primary" UI toggle swaps these with the primary cols,
     *  so the primary cols are always the active route. See migration 0062. */
    backupProvider: text('backup_provider'),
    backupModel: text('backup_model'),
    backupApiKeyId: uuid('backup_api_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    backupEnabled: boolean('backup_enabled').default(false).notNull(),
    /** Per-route host + tailnet flag (migration 0063). `baseUrl` overrides the
     *  provider's default host for this route (e.g. a self-hosted OpenAI-compat
     *  chat server); blank = provider default. `viaTailnet` dispatches this
     *  route's HTTP through the bundled Tailscale proxy so a baseUrl at a
     *  MagicDNS name reaches a NAT'd box (inert unless the tailnet profile is
     *  up). Both routes get their own pair, so a local-via-tailnet primary can
     *  pair with a cloud-direct backup. */
    baseUrl: text('base_url'),
    viaTailnet: boolean('via_tailnet').default(false).notNull(),
    backupBaseUrl: text('backup_base_url'),
    backupViaTailnet: boolean('backup_via_tailnet').default(false).notNull(),
    /** Per-agent VOICE: which `kind='tts'` ai_worker synthesises this agent's
     *  spoken replies. NULL = fall back to the owner's default TTS worker. The
     *  worker owns provider/voice/model/key; the agent just points at it. FK +
     *  ON DELETE SET NULL live in migration 0066. */
    ttsWorkerId: uuid('tts_worker_id'),
    systemPrompt: text('system_prompt').notNull(),
    /** Slugs of `skills` rows attached to this agent. Instructions are
     *  always-loaded into the system prompt (v1 activation model). */
    skillSlugs: text('skill_slugs')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    /** Slugs of `tool_groups` rows granted to this agent — named tool bundles.
     *  P6: the SOLE tool-grant mechanism. The runtime effective tool set is
     *  exactly the union of these groups' tools (the `tool_slugs` column was
     *  dropped in migration 0083). See docs/tools-and-skills.md. */
    toolGroupSlugs: text('tool_group_slugs')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    memoryConfig: jsonb('memory_config')
      .$type<AgentMemoryConfig>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    params: jsonb('params')
      .$type<AgentParams>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    /** Reflector appends notes here. */
    personaNotes: jsonb('persona_notes')
      .$type<PersonaNote[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    /** Avatar {style, seed}. Null → derived initials/accent avatar. */
    avatar: jsonb('avatar').$type<AgentAvatar | null>(),
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
