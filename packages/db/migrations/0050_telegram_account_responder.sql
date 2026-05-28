-- Link a Telegram bot (telegram_accounts) to the responder agent that owns it.
-- This lets the bot's token be entered + managed from the responder's
-- /settings/agents form (instead of the CLI seed script), and lets inbound
-- messages resolve to the bot's owning responder first.
--
-- NULL = unlinked: legacy / CLI-seeded bots keep the prior behaviour (global
-- highest-priority responder resolves them). ON DELETE SET NULL: deleting the
-- agent unbinds the bot but never destroys the bot row or its message history
-- (a hard delete would cascade telegram_chats + telegram_messages).
alter table "telegram_accounts"
  add column if not exists "responder_agent_id" uuid references "agents"("id") on delete set null;

-- A responder owns at most one bot. Partial unique so the many NULL (unlinked)
-- rows don't collide.
create unique index if not exists "telegram_accounts_responder_uq"
  on "telegram_accounts" ("responder_agent_id")
  where "responder_agent_id" is not null;
