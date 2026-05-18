-- Observability: per-run trace + ordered sub-steps.
--
-- Every meaningful unit of work that runs in the agent process becomes a
-- `traces` row, with an ordered tree of `trace_steps` underneath. Steps
-- nest via parent_step_id so reactflow can render the full call graph;
-- ordinal preserves order within a parent (or among root steps when
-- parent_step_id is null).
--
-- Token + cost aggregates live on the trace row so the `/traces` list and
-- the `/debug` dashboard widgets don't have to sum thousands of steps.

do $$ begin
  create type "public"."trace_kind" as enum (
    'responder_turn', 'extractor_run', 'summarizer_run', 'reflector_run', 'manual'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type "public"."trace_status" as enum ('running', 'success', 'error');
exception when duplicate_object then null; end $$;

create table if not exists "public"."traces" (
  "id"                 uuid primary key default gen_random_uuid(),
  "owner_id"           uuid not null references auth.users(id) on delete cascade,
  "kind"               "public"."trace_kind" not null,
  "subject_id"         uuid,
  "subject_kind"       text,
  "agent_id"           uuid references "public"."agents"(id) on delete set null,
  "status"             "public"."trace_status" not null default 'running',
  "started_at"         timestamptz not null default now(),
  "finished_at"        timestamptz,
  "duration_ms"        integer,
  "cost_micro_usd"     bigint not null default 0,
  "tokens_in"          integer not null default 0,
  "tokens_out"         integer not null default 0,
  "tokens_cache_read"  integer not null default 0,
  "step_count"         integer not null default 0,
  "error"              text,
  "data"               jsonb not null default '{}'::jsonb,
  "created_at"         timestamptz not null default now()
);

-- "Recent traces of this kind for this owner" — hot listing query.
create index if not exists "traces_owner_kind_started_idx"
  on "public"."traces" ("owner_id", "kind", "started_at" desc);

-- "All failing traces, newest first" — top errors widget.
create index if not exists "traces_status_failing_idx"
  on "public"."traces" ("started_at" desc) where "status" = 'error';

-- "What traces touched this subject?" — drill from a node/message/chat.
create index if not exists "traces_subject_idx"
  on "public"."traces" ("subject_kind", "subject_id");

do $$ begin
  create type "public"."trace_step_kind" as enum (
    'db_read', 'db_write', 'llm_call', 'embed', 'http', 'notify', 'compute', 'send'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type "public"."trace_step_status" as enum ('running', 'success', 'error', 'skipped');
exception when duplicate_object then null; end $$;

create table if not exists "public"."trace_steps" (
  "id"              uuid primary key default gen_random_uuid(),
  "trace_id"        uuid not null references "public"."traces"(id) on delete cascade,
  "parent_step_id"  uuid references "public"."trace_steps"(id) on delete cascade,
  "ordinal"         integer not null,
  "name"            text not null,
  "kind"            "public"."trace_step_kind" not null,
  "status"          "public"."trace_step_status" not null default 'running',
  "started_at"      timestamptz not null default now(),
  "finished_at"     timestamptz,
  "duration_ms"     integer,
  "input"           jsonb not null default '{}'::jsonb,
  "output"          jsonb not null default '{}'::jsonb,
  "meta"            jsonb not null default '{}'::jsonb,
  "error"           text,
  "created_at"      timestamptz not null default now()
);

create index if not exists "trace_steps_trace_idx"
  on "public"."trace_steps" ("trace_id", "ordinal");

create index if not exists "trace_steps_parent_idx"
  on "public"."trace_steps" ("parent_step_id");

create index if not exists "trace_steps_failing_idx"
  on "public"."trace_steps" ("trace_id") where "status" = 'error';
