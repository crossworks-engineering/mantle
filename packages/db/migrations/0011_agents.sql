-- Agents: first-class config rows for the AI agents that operate on Mantle's
-- behalf. Replaces the env-var-only configuration that the Telegram responder
-- used to live on (AGENT_MODEL / AGENT_PERSONA). Each row carries the model,
-- the API key to use (FK into the encrypted vault), the system prompt, memory
-- settings, and a priority for tie-breaking when multiple agents share a role.

do $$ begin
  create type "public"."agent_role" as enum (
    'assistant', 'responder', 'extractor', 'summarizer', 'custom'
  );
exception when duplicate_object then null; end $$;

create table if not exists "public"."agents" (
  "id"              uuid primary key default gen_random_uuid(),
  "owner_id"       uuid not null references auth.users(id) on delete cascade,
  "slug"            text not null,
  "name"            text not null,
  "description"     text,
  "role"            "public"."agent_role" not null default 'custom',
  -- OpenRouter slug (e.g. anthropic/claude-sonnet-4.6, deepseek/deepseek-chat).
  "model"           text not null,
  -- Which entry in api_keys to use. ON DELETE SET NULL so deleting a key
  -- doesn't cascade-delete agents — they just go un-runnable until repointed.
  "api_key_id"      uuid references "public"."api_keys"(id) on delete set null,
  "system_prompt"   text not null,
  -- Allowlist of MCP tool names the agent may call. Unused in v1.
  "tools"           jsonb not null default '[]'::jsonb,
  -- { history_limit: 20, history_window_hours: null, … }
  "memory_config"   jsonb not null default '{}'::jsonb,
  -- { temperature: 0.7, max_tokens: 1024, top_p: …, … }
  "params"          jsonb not null default '{}'::jsonb,
  -- Higher number = higher priority. Active responder is ORDER BY priority DESC LIMIT 1.
  "priority"        integer not null default 100,
  "enabled"         boolean not null default true,
  "last_used_at"    timestamptz,
  "usage_count"     bigint  not null default 0,
  "created_at"      timestamptz not null default now(),
  "updated_at"      timestamptz not null default now()
);

create unique index if not exists "agents_owner_slug_uq"
  on "public"."agents"("owner_id", "slug");

-- Index supports "give me the highest-priority enabled agent of this role".
create index if not exists "agents_owner_role_priority_idx"
  on "public"."agents"("owner_id", "role", "priority" desc)
  where enabled = true;
