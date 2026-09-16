-- Fire `conversation_changed` when a streamed reply is finalized, not only
-- when its row is inserted.
--
-- Since the durable runner (migration 0105) an outbound assistant_messages row
-- is INSERTed 'pending' with EMPTY text at turn start and UPDATEd to 'complete'
-- with the reply text when the turn ends. The 0091 trigger fired AFTER INSERT
-- only, so every consumer of the NOTIFY saw the row while it was still empty
-- and never heard about the finalize. For the push-notify worker that meant a
-- sealed teaser with an empty body on every phone ("Saskia" and nothing under
-- it), because latestOutbound() read the row the instant it appeared.
--
-- Now the trigger also fires AFTER UPDATE OF status, only when the status
-- actually changed (pending -> complete | failed), and the payload carries
-- `status` so a listener can tell a placeholder from a finished turn. The
-- synchronous write path inserts rows already 'complete', so those still
-- notify once, on insert, exactly as before.

create or replace function "public"."notify_conversation_changed"() returns trigger as $$
begin
  if (tg_op = 'UPDATE' and new.status is not distinct from old.status) then
    return new;
  end if;
  perform pg_notify(
    'conversation_changed',
    json_build_object(
      'ownerId', new.owner_id,
      'agentSlug', (select slug from "public"."agents" where id = new.agent_id),
      'direction', new.direction,
      'status', new.status
    )::text
  );
  return new;
end;
$$ language plpgsql;

drop trigger if exists "assistant_messages_conversation_changed_trg" on "public"."assistant_messages";

create trigger "assistant_messages_conversation_changed_trg"
  after insert or update of status on "public"."assistant_messages"
  for each row execute function "public"."notify_conversation_changed"();
