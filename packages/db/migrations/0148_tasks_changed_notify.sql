-- Realtime channel for task mutations the node_ingested bridge misses.
--
-- Inserts already reach every tab (trigger 0018 fires node_ingested on INSERT)
-- and content edits do too (updateTask calls notifyNodeIngested when the
-- summary-relevant fields move). But two mutations were invisible until a
-- manual reload: DELETE (nothing notifies at all — another tab keeps showing
-- the dead task) and rank/tags-only UPDATEs (deliberately NOT re-ingested so a
-- board drag can never trigger an LLM pass). With refetchOnWindowFocus off
-- app-wide, a view that misses a change never self-heals.
--
-- Same design as 0135 (runs_changed): a trigger rather than hand-placed
-- notifies, because a trigger cannot be bypassed by a new write path. Payload
-- is the OWNER id (the pending_changed convention) — for a delete there is no
-- row left to look up, so the client just refetches its task list. NOTIFY is
-- transactional and identical payloads inside one transaction collapse, so a
-- bulk operation wakes the browser once. This channel feeds ONLY the SSE
-- bridge (server/web/lib/realtime.ts); the extractor listens elsewhere — no
-- LLM work can be triggered from here.

create or replace function "public"."notify_tasks_changed"()
  returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform pg_notify('tasks_changed', old.owner_id::text);
    return old;
  end if;
  perform pg_notify('tasks_changed', new.owner_id::text);
  return new;
end
$$;
--> statement-breakpoint
drop trigger if exists "tasks_changed_upd_trg" on "public"."nodes";
--> statement-breakpoint
create trigger "tasks_changed_upd_trg"
  after update on "public"."nodes"
  for each row
  when (new.type = 'task' or old.type = 'task')
  execute function "public"."notify_tasks_changed"();
--> statement-breakpoint
drop trigger if exists "tasks_changed_del_trg" on "public"."nodes";
--> statement-breakpoint
create trigger "tasks_changed_del_trg"
  after delete on "public"."nodes"
  for each row
  when (old.type = 'task')
  execute function "public"."notify_tasks_changed"();
