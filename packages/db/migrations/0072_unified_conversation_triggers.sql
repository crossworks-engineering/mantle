-- Phase 3 cutover (docs/conversation.md): swap the summarize triggers onto the
-- unified per-agent stream. From here, EVERY conversation turn — web, Telegram,
-- and future channels — lands in assistant_messages and fires `summarize_due`
-- with the AGENT id, so one trigger + one LISTEN handler drives summarization
-- for all channels.
--
-- BREAKING: must land together with the apps/agent code that (a) writes Telegram
-- turns into assistant_messages and (b) reads `summarize_due` as an agent id.
-- This replaces the two prior triggers:
--   0013: telegram_messages AFTER INSERT → summarize_due(chat_id)
--   0044: assistant_messages AFTER INSERT → summarize_web_due(owner_id)

-- The notify_summarize_due function is repurposed: payload chat_id (old, bound
-- to telegram_messages) → agent_id (new, bound to assistant_messages). Drop the
-- old telegram trigger FIRST so it can't fire the repurposed function against a
-- telegram_messages row (which has no usable agent_id for inbound).
drop trigger if exists "telegram_messages_summarize_due_trg" on "public"."telegram_messages";

create or replace function "public"."notify_summarize_due"() returns trigger as $$
begin
  -- agent_id is NOT NULL on assistant_messages; guard defensively anyway.
  if new.agent_id is not null then
    perform pg_notify('summarize_due', new.agent_id::text);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists "assistant_messages_summarize_due_trg" on "public"."assistant_messages";
create trigger "assistant_messages_summarize_due_trg"
  after insert on "public"."assistant_messages"
  for each row execute function "public"."notify_summarize_due"();

-- Retire the web-only channel — assistant_messages now drives summarize_due
-- directly for EVERY channel, so the separate summarize_web_due is redundant.
drop trigger if exists "assistant_messages_summarize_web_due_trg" on "public"."assistant_messages";
drop function if exists "public"."notify_summarize_web_due"();
