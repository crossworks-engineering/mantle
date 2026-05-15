-- Observability for the email sync worker. One row per sync invocation:
-- when it started, how it finished, how many messages it touched. Survives
-- the worker process so we can answer "did sync run at 3am?" and "why is
-- the inbox quiet today?" from Studio (or, later, a `/settings/health`
-- page) without grepping logs.

do $$ begin
  create type "public"."sync_status" as enum ('running', 'ok', 'error');
exception when duplicate_object then null; end $$;

create table if not exists "public"."sync_runs" (
  "id"           uuid primary key default gen_random_uuid(),
  "account_id"   uuid not null references "public"."email_accounts"(id) on delete cascade,
  "started_at"   timestamptz not null default now(),
  "finished_at"  timestamptz,
  "duration_ms"  integer generated always as (
    case when finished_at is not null
      then extract(milliseconds from (finished_at - started_at))::integer
      else null
    end
  ) stored,
  "status"       "public"."sync_status" not null default 'running',
  "scanned"      integer not null default 0,
  "ingested"     integer not null default 0,
  "new_senders"  integer not null default 0,
  "error"        text
);

create index if not exists "sync_runs_account_started_idx"
  on "public"."sync_runs" ("account_id", "started_at" desc);
create index if not exists "sync_runs_status_idx"
  on "public"."sync_runs" ("status") where status <> 'ok';
