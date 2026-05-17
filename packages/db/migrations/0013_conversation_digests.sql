-- Tier-2 memory for Telegram conversations.
--
-- Each `telegram_messages` row eventually gets folded into a digest node
-- (type='note', tags including 'conversation-digest'). Until that happens
-- `digest_node_id` is NULL — the "needs summarization" signal. The
-- summarizer agent listens on the `summarize_due` channel and decides when
-- enough undigested turns have accumulated in a chat to roll them up.

alter table "public"."telegram_messages"
  add column if not exists "digest_node_id" uuid
    references "public"."nodes"(id) on delete set null;

-- Hot query: "give me the oldest N undigested turns in this chat."
create index if not exists "telegram_messages_chat_undigested_idx"
  on "public"."telegram_messages"("chat_id", "sent_at")
  where "digest_node_id" is null;

-- Cheap NOTIFY on every insert (inbound or outbound). The listener inside
-- apps/agent owns the threshold + debounce logic, so this trigger has no
-- knowledge of agent config — it just announces "something changed in this
-- chat."
create or replace function "public"."notify_summarize_due"()
  returns trigger language plpgsql as $$
begin
  perform pg_notify('summarize_due', new.chat_id::text);
  return new;
end
$$;

drop trigger if exists "telegram_messages_summarize_due_trg"
  on "public"."telegram_messages";
create trigger "telegram_messages_summarize_due_trg"
  after insert on "public"."telegram_messages"
  for each row execute function "public"."notify_summarize_due"();
