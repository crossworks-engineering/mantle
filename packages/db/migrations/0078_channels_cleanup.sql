-- Comms channels cleanup (docs/comms-channels.md §5 step 4 / §10 step 4).
--
-- The dual-read transition is over: every bot is bound through `channels`
-- (channels.agent_id is the binding; channels.credentials_enc holds the token,
-- sealed under the channel id). Drop the now-dead legacy columns on
-- telegram_accounts:
--   - responder_agent_id  + its partial-unique index (role-coupled binding)
--   - bot_token_enc       (token now lives only on the channel)
--
-- DESTRUCTIVE + one-way. Ship only after the channel path has been verified in
-- prod (every telegram_accounts row has a channel_id and its channel's
-- credentials_enc opens). A raw-copied/unmigrated token here is unrecoverable.
--
-- SELF-GUARD: the token re-seal into channels.credentials_enc happens in APP
-- code (AES-GCM needs MANTLE_MASTER_KEY), which runs AFTER this SQL migrate
-- gate. So this migration must NOT run in the same deploy that first creates
-- `channels` — the backfill would not have populated it yet, and dropping
-- bot_token_enc would lose the live bot's token. Abort loudly if any ENABLED
-- account still lacks a channel link; the operator then deploys the additive
-- phases first, lets the backfill run, verifies, and re-deploys this.
DO $$
DECLARE
  orphans int;
BEGIN
  SELECT count(*) INTO orphans
    FROM telegram_accounts
   WHERE enabled AND channel_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'comms-channels cleanup aborted: % enabled telegram_accounts have no channel_id. Deploy the additive phases first (channels backfill runs at agent/poller startup), verify channels.credentials_enc opens, then re-deploy this migration. See docs/comms-channels.md §5/§9.',
      orphans;
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "telegram_accounts_responder_uq";
--> statement-breakpoint
ALTER TABLE "telegram_accounts" DROP COLUMN IF EXISTS "responder_agent_id";
--> statement-breakpoint
ALTER TABLE "telegram_accounts" DROP COLUMN IF EXISTS "bot_token_enc";
