/**
 * AI Workers — one-shot LLM and media transformation jobs.
 *
 * Sibling to `agents` (which holds conversational reasoners with
 * persona/memory/tool-loops). Workers do one job per invocation and
 * are triggered by system events (a node lands → extractor runs; a
 * timer fires → reflector runs; a voice message arrives → STT runs;
 * an outbound reply is voice-marked → TTS runs).
 *
 * Each kind has its own `params` shape. See the typed exports below;
 * the runtime narrows on `kind` and reads the relevant fields.
 *
 * See migration 0027_ai_workers.sql for the table + backfill.
 */

import { sql } from 'drizzle-orm';
import {
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

export const aiWorkerKind = pgEnum('ai_worker_kind', [
  'reflector',
  'extractor',
  'summarizer',
  'tts',
  'stt',
  'vision',
  // Documents (PDF) sent NATIVELY to a doc-capable model (Claude/Gemini) —
  // separate from image vision so the operator can run a cheap model for photo
  // describe but a strong one for invoices/statements. See migration 0051.
  'document',
  'image_gen',
  // Embedding is genuinely cross-cutting — used by the extractor (writes),
  // the responder/assistant for semantic-memory retrieval, the recall
  // builtin, MCP search, and the tool-result spill store. Making it a
  // first-class worker gives one canonical pick point instead of a
  // misleading "override" field on the extractor only. See migration
  // 0047 and `resolveEmbeddingModel` in `@mantle/embeddings`.
  'embedding',
]);

export type AiWorkerKind = (typeof aiWorkerKind.enumValues)[number];

// ─── Per-kind params types ───────────────────────────────────────────
//
// One discriminated union per kind. The runtime reads `params` as the
// right shape after narrowing on `kind`. Adding a new field is a one-
// line change here + the matching UI field; no migration needed
// because `params` is jsonb.

/** Params for `kind='tts'` workers. */
export type TtsParams = {
  /** Voice id. For OpenAI this is one of the published names
   *  (alloy/ash/ballad/cedar/coral/echo/fable/marin/nova/onyx/sage/
   *  shimmer/verse). For xAI it's either a preset (eve/ara/rex/sal/
   *  leo) OR a custom-generated id from the xAI console like
   *  '69smp8rm'. For ElevenLabs it's either a premade voice id or
   *  one of the user's cloned voice ids. For Google it's a name from
   *  GOOGLE_TTS_VOICES. Stored as a free-form string so custom ids
   *  flow through end-to-end; the UI narrows the dropdown to known
   *  voices but accepts arbitrary input for providers that support
   *  it. */
  voice?: string;
  /** Legacy param — model now lives on the worker row's `model` column.
   *  Kept for backward-compat with rows created before the move. */
  model?: 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts';
  /** Playback speed multiplier 0.25–4.0. */
  speed?: number;
  /** Output container — 'opus' for Telegram-native voice notes. */
  format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  /** Free-text style hint passed to gpt-4o-mini-tts ("speak warmly",
   *  "calm and slow"). Older models silently ignore it. */
  instructions?: string;
  /** BCP-47 language hint (e.g. 'en', 'fr', 'pt-BR') or 'auto'.
   *  Forces xAI/Google TTS to speak in that language — required when
   *  a cloned voice should keep its native accent regardless of
   *  what's in the text. OpenAI and ElevenLabs ignore this. */
  language?: string;
};

/** Params for `kind='stt'` workers (speech-to-text). */
export type SttParams = {
  /** Optional ISO-639-1 hint to disambiguate ambiguous audio.
   *  Whisper auto-detects when omitted, which is usually what we want. */
  language?: string;
  /** Hard cap on source duration in seconds. Refuses long clips
   *  before paying for transcription. Default 180 (3 min). */
  max_duration_seconds?: number;
};

/** Params for `kind='vision'` workers (image → text). */
export type VisionParams = {
  /** Prompt template passed alongside the image. Used for "extract
   *  the contents of this whiteboard as markdown" etc. */
  extraction_prompt?: string;
  /** Max output tokens. Vision-LLMs run unbounded otherwise. */
  max_tokens?: number;
};

/** Params for `kind='document'` workers (PDF → text, sent natively). Same
 *  shape as vision: a transcription prompt + an output cap (documents
 *  transcribe in one call, so this should be generous). */
export type DocumentParams = {
  extraction_prompt?: string;
  max_tokens?: number;
  /** Send PDFs to the model natively even when they HAVE a text layer, instead
   *  of trusting `pdf-parse`. Off by default (cheap text path); turn on when
   *  documents are tabular (invoices/statements) and the text layer mangles
   *  columns — the model reads the real layout. Costs one LLM call per PDF. */
  prefer_native?: boolean;
};

/** Params for `kind='image_gen'` workers. */
export type ImageGenParams = {
  /** Output size, provider-specific. '1024x1024' is a safe default. */
  size?: string;
  /** Style hint passed to the provider (e.g. DALL-E 3's 'vivid'/'natural'). */
  style?: string;
  /** Quality tier ('standard' or 'hd' for DALL-E 3). */
  quality?: string;
};

/** Params shared by the LLM-driven one-shot workers. They invoke a chat
 *  model with a system_prompt, so they have temperature + max_tokens
 *  knobs like a regular chat call. */
type ChatLlmParams = {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  /** Hugging Face router policy suffix. Appended to the model id at
   *  call time (e.g. 'openai/gpt-oss-120b' becomes 'openai/gpt-oss-
   *  120b:fastest'). Honoured only when the worker's provider is
   *  'huggingface'; other adapters ignore it. Valid values:
   *  'fastest' (lowest latency, default), 'cheapest' (lowest cost),
   *  'preferred' (use account preference list). Leaving blank also
   *  means 'fastest'. */
  huggingface_routing?: 'fastest' | 'cheapest' | 'preferred';
};

/** Params for `kind='reflector'`. The reflector reads recent dialog
 *  and proposes new persona_notes. */
export type ReflectorParams = ChatLlmParams & {
  /** How many recent turns to review per run. Default 50. */
  window_size?: number;
  /** Max notes to append in a single run (defence against runaway). */
  max_notes_per_run?: number;
};

/** Params for `kind='extractor'`. The extractor reads one node and
 *  produces a structured summary + tags + entities. */
export type ExtractorParams = ChatLlmParams & {
  /** Node types this extractor handles. Default: all ingestable kinds. */
  target_types?: string[];
  /** Legacy alias for `target_types` — kept readable for rows backfilled
   *  from the old `agents.memory_config.extract_types`. New code writes
   *  `target_types`; the runtime falls back to this if missing. */
  extract_types?: string[];
  /** Whether to do the fact-extraction pass (in addition to summary +
   *  entity extraction). Defaults to true. */
  extract_facts?: boolean;
  // NOTE: no per-extractor embedding_model. The embedder is the single
  // `embedding_config` row (migration 0061) — the extractor embeds through it.
  /** Hard cost cap per node extraction in micro-USD. Once the running
   *  trace cost exceeds this, remaining facts are dropped and a warning
   *  is logged. Null = no cap. */
  extract_cost_cap_micro_usd?: number | null;
};

/** Params for `kind='summarizer'`. The summarizer rolls up chat
 *  history into conversation digests. */
export type SummarizerParams = ChatLlmParams & {
  /** Min undigested turns before we attempt to roll up a chat. Legacy
   *  name kept since backfilled rows use this exact key. */
  summarize_threshold?: number;
  /** Max turns to include in one digest's LLM call. */
  summarize_batch?: number;
  /** Convenience alias matching the new naming convention. Equivalent
   *  to `summarize_batch`. */
  window_size?: number;
  /** Target length of the resulting summary in tokens. */
  target_length_tokens?: number;
};

/** Params for `kind='embedding'`. Deliberately tiny — embedding is a pure
 *  text→vector transformation; there's no system_prompt, no temperature,
 *  no max_tokens, no streaming choice to make. Just the model (which lives
 *  on the row's `model` column) and an optional dimension override for
 *  models that support it (currently only `google/gemini-embedding-2-preview`
 *  via OpenRouter, which honours `output_dimensionality`). */
export type EmbeddingParams = {
  /** Dimension override sent to providers that accept it. Since migration
   *  0060 the DB column is `vector(768)`, so callers MUST keep this at 768 or
   *  re-embed. Setting it to anything else would mismatch the index and crash
   *  inserts. The worker form surfaces a warning to prevent that footgun. */
  output_dimensions?: number;
};

/** Discriminated union for type-narrowing at call sites. */
export type AiWorkerParams =
  | TtsParams
  | SttParams
  | VisionParams
  | DocumentParams
  | ImageGenParams
  | ReflectorParams
  | ExtractorParams
  | SummarizerParams
  | EmbeddingParams;

export const aiWorkers = pgTable(
  'ai_workers',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    kind: aiWorkerKind('kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    /** Optional BACKUP chat route — same shape as the active provider/model/
     *  apiKeyId above. On a route-DOWN / 429 failure of the primary the runtime
     *  fails over here (a chat backup may be a different model). The "make
     *  backup primary" toggle swaps these with the primary cols. Migration 0062.
     *  Not used by non-chat kinds (tts/stt/vision/embedding ignore it). */
    backupProvider: text('backup_provider'),
    backupModel: text('backup_model'),
    backupApiKeyId: uuid('backup_api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    backupEnabled: boolean('backup_enabled').default(false).notNull(),
    systemPrompt: text('system_prompt'),
    params: jsonb('params').$type<AiWorkerParams>().default(sql`'{}'::jsonb`).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    priority: integer('priority').default(100).notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    usageCount: integer('usage_count').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('ai_workers_owner_slug_uq').on(t.ownerId, t.slug),
    // Partial unique index: only one default per (owner, kind).
    uniqueIndex('ai_workers_default_per_kind_uq')
      .on(t.ownerId, t.kind)
      .where(sql`${t.isDefault} = true`),
    index('ai_workers_owner_kind_idx').on(t.ownerId, t.kind),
    index('ai_workers_enabled_idx').on(t.enabled),
  ],
);

export type AiWorker = typeof aiWorkers.$inferSelect;
export type NewAiWorker = typeof aiWorkers.$inferInsert;
