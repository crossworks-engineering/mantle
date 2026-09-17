-- Realtime channel for node_comments (0147): a comment appearing, being
-- edited, or being deleted repaints every open thread — including the OTHER
-- side of the owner/member boundary (a member comment must show up on the
-- owner's /tasks detail live, and vice versa).
--
-- Payload is JSON {ownerId, nodeId} — the conversation_changed convention —
-- so the bridge can emit a change typed 'comment' carrying the node id and a
-- client invalidates just that thread (plus its task-list counts). Trigger,
-- not hand-placed notifies, for the 0135 reason: no write path can forget it.
-- Notify-only; nothing here can reach an LLM.

create or replace function "public"."notify_comments_changed"()
  returns trigger language plpgsql as $$
declare
  r record;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  perform pg_notify(
    'comments_changed',
    json_build_object('ownerId', r.owner_id, 'nodeId', r.node_id)::text
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
--> statement-breakpoint
drop trigger if exists "comments_changed_ins_trg" on "public"."node_comments";
--> statement-breakpoint
create trigger "comments_changed_ins_trg"
  after insert on "public"."node_comments"
  for each row execute function "public"."notify_comments_changed"();
--> statement-breakpoint
drop trigger if exists "comments_changed_upd_trg" on "public"."node_comments";
--> statement-breakpoint
create trigger "comments_changed_upd_trg"
  after update on "public"."node_comments"
  for each row execute function "public"."notify_comments_changed"();
--> statement-breakpoint
drop trigger if exists "comments_changed_del_trg" on "public"."node_comments";
--> statement-breakpoint
create trigger "comments_changed_del_trg"
  after delete on "public"."node_comments"
  for each row execute function "public"."notify_comments_changed"();
