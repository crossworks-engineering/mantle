-- email_send and email_page come back (Sync service plan M2, page f11288e3):
-- the Sync service sends mail again. Sync M4 put both on the manifest's
-- retired list, and the boot reconcile switched their builtin rows off
-- (disableRetiredManifestItems). They left that list in this release; this
-- switches the rows that reconcile switched off back on, once.
--
-- Only builtin rows (an operator's own tool of that name is left alone),
-- and only rows that are off. A row an operator switched off by hand before
-- M4 is switched on too: the reconcile left no mark of which it switched
-- off. The per-row confirm (requires_confirm) is untouched: both still wait
-- for a person by default. The send policy switch and the Sync switch still
-- gate them. Re-runnable (it only ever switches rows on).
-- Revert: packages/db/rollback/0381_email_send_back.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."tools"
SET "enabled" = true, "updated_at" = now()
WHERE "slug" IN ('email_send', 'email_page')
  AND "handler"->>'kind' = 'builtin'
  AND "enabled" = false;
