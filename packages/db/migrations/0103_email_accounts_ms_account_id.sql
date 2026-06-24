-- M2: Outlook mail reuses the email pipeline. A connected Microsoft account
-- gets a companion `email_accounts` row (provider='microsoft') so the emails FK
-- + contact gate + classifier + extractor all work unchanged; this column links
-- that row back to the `ms_accounts` row whose OAuth token drives Graph sync.
-- ON DELETE CASCADE so disconnecting the Microsoft account removes its mailbox
-- account too. See docs/microsoft-graph-ingest.md.
ALTER TABLE "email_accounts"
	ADD COLUMN "ms_account_id" uuid REFERENCES "ms_accounts"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "email_accounts_ms_account_idx" ON "email_accounts" ("ms_account_id");
