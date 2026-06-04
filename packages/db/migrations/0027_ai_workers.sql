-- AI Workers — one-shot LLM and media transformation jobs.
--
-- Why this exists: the `agents` table was holding two distinct concepts:
--   1. Conversational agents (responder, assistant, custom) — multi-turn,
--      have persona_notes, memory, tool_loops, take user turns.
--   2. One-shot workers (reflector, extractor, summarizer) — triggered by
--      system events, do one LLM call, parse output, done. No persona,
--      no memory, no tool loop.
--
-- Plus there's a third category arriving: media transformations (TTS,
-- STT, vision, image-gen). They share the "one-shot" shape of workers
-- but call non-chat APIs.
--
-- All three of (1)/(2)/(3) need: api_key binding, provider + model,
-- some config blob, enable + default flag, test surface. But only (1)
-- needs persona, memory, tools, conversation history.
--
-- So we split:
--   - `agents`     stays for (1) — conversational reasoners.
--   - `ai_workers` (new) holds (2) and (3) — one-shot jobs of any kind.
--
-- The reflector/extractor/summarizer rows get backfilled from `agents`
-- in this migration. Code in apps/agent/src/{reflector,extractor,
-- summarizer}.ts is updated in the same commit to read from ai_workers.

CREATE TYPE ai_worker_kind AS ENUM (
  -- LLM-driven one-shot jobs (kept the same names as the old agentRole
  -- values so backfill is a no-op cast).
  'reflector',
  'extractor',
  'summarizer',
  -- Media transformations. None of these need a system_prompt; they
  -- call dedicated APIs with kind-specific params.
  'tts',           -- text-to-speech (e.g. OpenAI TTS, ElevenLabs)
  'stt',           -- speech-to-text (e.g. OpenAI Whisper, Deepgram)
  'vision',        -- image → text (whiteboards, receipts, doc scans)
  'image_gen'      -- text → image (e.g. DALL-E, Stable Diffusion)
);

CREATE TABLE ai_workers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL,
  -- Stable handle used by code (e.g. 'main-extractor'). Unique per owner.
  slug        text NOT NULL,
  -- Display label. Free-form; what shows in /settings/ai-workers list.
  name        text NOT NULL,
  kind        ai_worker_kind NOT NULL,
  -- Free text. 'openrouter' for chat-shaped workers; 'openai' for TTS
  -- and STT; 'anthropic' for direct vision; etc. Drives nothing
  -- automatically — the worker file knows which client to construct.
  provider    text NOT NULL,
  -- Model identifier in provider's namespace. e.g. 'anthropic/claude-
  -- haiku-4.5' for OpenRouter, 'whisper-1' for OpenAI Whisper,
  -- 'tts-1' for OpenAI TTS, 'gpt-4o' for vision.
  model       text NOT NULL,
  -- Which api_keys row to use. NULL if not yet configured — UI lets
  -- the user pick from their saved keys.
  api_key_id  uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  -- Only set for kinds that use one (reflector/extractor/summarizer/
  -- vision). TTS/STT/image_gen leave this NULL.
  system_prompt text,
  -- Kind-specific config. Keeps the column count sane while letting
  -- each kind carry its own knobs (TTS voice/speed/format, extractor
  -- target_types, reflector window_size, vision prompt template, …).
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled     boolean NOT NULL DEFAULT true,
  -- Higher wins when there are several enabled workers of the same kind.
  priority    integer NOT NULL DEFAULT 100,
  -- One row per (owner, kind) carries the default flag. Enforced by
  -- the partial unique index below. The runtime asks for "the default
  -- TTS worker for this owner" rather than naming a specific slug.
  is_default  boolean NOT NULL DEFAULT false,
  -- Telemetry.
  last_used_at timestamptz,
  usage_count  integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (owner_id, slug)
);

-- One default per (owner_id, kind). Partial unique index — multiple
-- non-default rows of the same kind are fine (you can have three TTS
-- configs and pick which is default).
CREATE UNIQUE INDEX ai_workers_default_per_kind_uq
  ON ai_workers (owner_id, kind)
  WHERE is_default = true;

CREATE INDEX ai_workers_owner_kind_idx ON ai_workers (owner_id, kind);
CREATE INDEX ai_workers_enabled_idx ON ai_workers (enabled);

-- ─── Backfill from agents ───────────────────────────────────────────
--
-- Every existing row where role IN (reflector, extractor, summarizer)
-- becomes an ai_workers row. The highest-priority enabled row per
-- (owner, kind) gets is_default=true so the runtime lookup finds it.
--
-- `provider` is set to 'openrouter' for all backfilled rows because
-- that's what the existing worker code uses. If the user later
-- switches a worker to a direct provider, they re-pick model + key
-- in the UI and the provider field is updated.

INSERT INTO ai_workers (
  owner_id, slug, name, kind, provider, model, api_key_id,
  system_prompt, params, enabled, priority, is_default,
  last_used_at, usage_count, created_at, updated_at
)
SELECT
  a.owner_id,
  a.slug,
  a.name,
  a.role::text::ai_worker_kind,
  'openrouter',
  a.model,
  a.api_key_id,
  a.system_prompt,
  -- Old extractor stored `extract_types` in memory_config; old reflector
  -- stored window/cap fields there too. Merge memory_config into params
  -- so the new code can read everything from one place. memory_config
  -- wins on key clash since that's where the live values live.
  -- Add `target_types` only when the old worker carried `extract_types`.
  -- (Was `jsonb_build_object(...) FILTER (WHERE ...)`, which is invalid —
  -- FILTER only applies to aggregates, so a from-scratch replay errored
  -- 42809. Existing DBs already applied 0027 and the timestamp-gated migrator
  -- never re-runs it, so this fix is a no-op for them and unblocks fresh
  -- installs / CI / disaster-recovery replays.)
  coalesce(a.params, '{}'::jsonb) || coalesce(a.memory_config, '{}'::jsonb)
    || (CASE WHEN a.memory_config ? 'extract_types'
              THEN jsonb_build_object('target_types', a.memory_config->'extract_types')
              ELSE '{}'::jsonb END),
  a.enabled,
  a.priority,
  -- DISTINCT ON picks the winner per (owner, kind) by priority.
  (a.id IN (
    SELECT DISTINCT ON (owner_id, role) id
    FROM agents
    WHERE role IN ('reflector', 'extractor', 'summarizer') AND enabled = true
    ORDER BY owner_id, role, priority DESC, created_at ASC
  )) AS is_default,
  a.last_used_at,
  a.usage_count,
  a.created_at,
  a.updated_at
FROM agents a
WHERE a.role IN ('reflector', 'extractor', 'summarizer');

-- We DO NOT delete the source rows from `agents` in this migration —
-- a separate later migration will drop the corresponding enum values
-- from agentRole and clear the rows, once the code has settled on
-- ai_workers. Keeping them avoids a dangerous "everything goes dark
-- if I rolled back wrong" scenario.
