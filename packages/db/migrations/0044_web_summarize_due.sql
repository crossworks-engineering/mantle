-- Web /assistant conversation digests. Mirror of migration 0013 (which fires
-- `summarize_due` on telegram_messages): fire `summarize_web_due` on each
-- assistant_messages insert so the summarizer rolls up web conversation too.
-- Payload is the owner id — the web surface is one continuous stream per owner,
-- with no chat id. The agent debounces and runs summarizeWebConversation().

create or replace function "public"."notify_summarize_web_due"()
  returns trigger language plpgsql as $$
begin
  perform pg_notify('summarize_web_due', new.owner_id::text);
  return new;
end
$$;

drop trigger if exists "assistant_messages_summarize_web_due_trg" on "public"."assistant_messages";
create trigger "assistant_messages_summarize_web_due_trg"
  after insert on "public"."assistant_messages"
  for each row execute function "public"."notify_summarize_web_due"();
