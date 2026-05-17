-- Promote `telegram_messages` to a bidirectional table. Outbound replies sent
-- by an agent now live alongside inbound DMs in the same table, distinguished
-- by `direction`. This gives the responder a single ordered stream to load
-- as conversational context.
--
-- Side effect: the pg_notify trigger now only fires for inbound rows so the
-- agent doesn't react to its own replies.

do $$ begin
  create type "public"."telegram_direction" as enum ('inbound', 'outbound');
exception when duplicate_object then null; end $$;

-- direction: existing rows are inbound; default keeps inserts safe.
alter table "public"."telegram_messages"
  add column if not exists "direction" "public"."telegram_direction" not null default 'inbound';

-- Inbound-only fields become nullable. The app enforces NOT NULL for inbound
-- rows via the runtime; outbound rows leave these empty.
alter table "public"."telegram_messages" alter column "telegram_update_id" drop not null;
alter table "public"."telegram_messages" alter column "from_user_id" drop not null;

-- Outbound provenance.
alter table "public"."telegram_messages"
  add column if not exists "agent_id" uuid references "public"."agents"(id) on delete set null;
alter table "public"."telegram_messages"
  add column if not exists "model_used" text;
alter table "public"."telegram_messages"
  add column if not exists "reply_to_id" uuid references "public"."telegram_messages"(id);

-- Outbound rows have no telegram_update_id, so the prior unique key
-- (account_id, telegram_update_id) needs to become a partial unique index.
drop index if exists "public"."telegram_messages_account_update_uq";
create unique index if not exists "telegram_messages_account_update_uq"
  on "public"."telegram_messages"("account_id", "telegram_update_id")
  where "telegram_update_id" is not null;

-- Conversation-history retrieval: chat_id + sent_at desc.
create index if not exists "telegram_messages_chat_sent_idx"
  on "public"."telegram_messages"("chat_id", "sent_at" desc);

-- Updated trigger: only NOTIFY for inbound rows.
create or replace function "public"."notify_telegram_message_inserted"()
  returns trigger language plpgsql as $$
begin
  if new.direction = 'inbound' then
    perform pg_notify('telegram_message_inserted', new.id::text);
  end if;
  return new;
end
$$;
