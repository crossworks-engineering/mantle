-- Live-chat fan-out. NOTIFY on every conversation turn so connected clients
-- (the mobile companion's SSE stream, /api/assistant/stream) refetch the
-- affected thread instead of polling. Distinct from `summarize_due` (which
-- carries agent_id only and drives summarization): this payload carries
-- owner + agent SLUG + direction, so the SSE route filters per owner and the
-- client (which keys threads by slug) can route the event with no id lookup,
-- and skip its own inbound echo. Fires on EVERY channel's turns, since all of
-- them land in assistant_messages (see docs/conversation.md). The slug subquery
-- is a single indexed PK lookup on agents.
create or replace function "public"."notify_conversation_changed"() returns trigger as $$
begin
  perform pg_notify(
    'conversation_changed',
    json_build_object(
      'ownerId', new.owner_id,
      'agentSlug', (select slug from "public"."agents" where id = new.agent_id),
      'direction', new.direction
    )::text
  );
  return new;
end;
$$ language plpgsql;

drop trigger if exists "assistant_messages_conversation_changed_trg" on "public"."assistant_messages";

create trigger "assistant_messages_conversation_changed_trg"
  after insert on "public"."assistant_messages"
  for each row execute function "public"."notify_conversation_changed"();
