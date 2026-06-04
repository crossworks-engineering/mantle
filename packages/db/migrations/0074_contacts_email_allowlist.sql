-- Contacts become the SOLE inbound email allowlist (retire sender curation).
--
-- 1. Move each contact's single `data.email` into a `data.emails` array (the
--    new multi-email shape; entries are addresses or `@domain` wildcards). The
--    going-forward write path is @mantle/content createContact/updateContact;
--    this is the one-time move for existing rows. Must ship atomically with the
--    content-package change that reads `data.emails` (see docs/email-ingest.md).
-- 2. Drop the sender-curation tables + enums — the ContactGate (contacts) is the
--    only gate now. No code reads these after this migration.
-- 3. Drop sync_runs.new_senders — there is no "new sender" concept anymore.

UPDATE nodes
SET data = jsonb_set(
             data - 'email',
             '{emails}',
             CASE
               WHEN coalesce(data->>'email', '') <> ''
                 THEN jsonb_build_array(lower(data->>'email'))
               ELSE '[]'::jsonb
             END,
             true
           )
WHERE type = 'contact'
  AND NOT (data ? 'emails');
--> statement-breakpoint
DROP TABLE IF EXISTS email_senders CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS email_sender_domains CASCADE;
--> statement-breakpoint
DROP TYPE IF EXISTS sender_status;
--> statement-breakpoint
DROP TYPE IF EXISTS sender_domain_status;
--> statement-breakpoint
ALTER TABLE sync_runs DROP COLUMN IF EXISTS new_senders;
