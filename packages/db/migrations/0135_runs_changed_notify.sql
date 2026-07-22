-- Realtime channel for the runner surfaces (/runs, the active-runs strip).
--
-- Runs are NOT nodes, so the `node_ingested` bridge never carried them and
-- every run view was static until a manual reload. Observed on the jason box
-- during the v0.158.0 dogfood: /runs sat on "No runs yet" through a run being
-- created, parking on a question, being answered and completing.
--
-- Why a trigger rather than a notify call in the engine: the engine mutates
-- runs from several processes and paths (run_* tools, the three queue
-- handlers, the sweep, the DBOS turn workflows), and a hand-placed notify is
-- only correct until the next path forgets one. A trigger cannot be bypassed.
-- Polling was the other option and is worse here — `refetchOnWindowFocus` is
-- off app-wide, so a view that misses a change never self-heals on its own.
--
-- Payload is the OWNER id, not a row id, matching the `pending_changed`
-- convention (apps/web/lib/realtime.ts broadcasts a typed change and the
-- client refetches). NOTIFY is transactional: nothing is delivered for a
-- rolled-back engine transaction, and identical payloads raised inside one
-- transaction collapse into a single delivery — so a batch that promotes ten
-- items wakes the browser once.
--
-- The UPDATE triggers carry WHEN clauses on purpose. Engine transactions
-- write bookkeeping columns (attempt, deadline_at, usage, cost, updated_at)
-- far more often than anything the run views render; firing on those would be
-- a notify storm that repaints nothing.

create or replace function "public"."notify_runs_changed"()
  returns trigger language plpgsql as $$
declare
  owner uuid;
begin
  -- run_items carries no owner_id — it hangs off runs.
  if tg_table_name = 'runs' then
    owner := new.owner_id;
  else
    select r.owner_id into owner from "public"."runs" r where r.id = new.run_id;
  end if;
  if owner is not null then
    perform pg_notify('runs_changed', owner::text);
  end if;
  return new;
end
$$;

drop trigger if exists "runs_changed_ins_trg" on "public"."runs";
create trigger "runs_changed_ins_trg"
  after insert on "public"."runs"
  for each row execute function "public"."notify_runs_changed"();

drop trigger if exists "runs_changed_upd_trg" on "public"."runs";
create trigger "runs_changed_upd_trg"
  after update on "public"."runs"
  for each row
  when (
    old.status is distinct from new.status
    or old.paused_at is distinct from new.paused_at
    or old.completed_at is distinct from new.completed_at
    or old.spent_micro_usd is distinct from new.spent_micro_usd
  )
  execute function "public"."notify_runs_changed"();

drop trigger if exists "run_items_changed_ins_trg" on "public"."run_items";
create trigger "run_items_changed_ins_trg"
  after insert on "public"."run_items"
  for each row execute function "public"."notify_runs_changed"();

drop trigger if exists "run_items_changed_upd_trg" on "public"."run_items";
create trigger "run_items_changed_upd_trg"
  after update on "public"."run_items"
  for each row
  when (
    old.state is distinct from new.state
    or old.children_done is distinct from new.children_done
    or old.sealed is distinct from new.sealed
  )
  execute function "public"."notify_runs_changed"();
