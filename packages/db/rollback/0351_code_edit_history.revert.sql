-- Rollback of 0351_code_edit_history: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Run it before pinning the older image: that image's History list and
-- snapshot lookups know nothing of `pre_code_edit` rows, so it would list
-- them under an empty label and could restore one, and a row holds only the
-- files one write changed, so a code restore from it would replace the
-- draft with a partial tree. This revert removes those rows (an undo record
-- only: the published versions and every snapshot stay), narrows the check
-- back, and takes 0351 off the ledger, so the next roll forward runs it
-- again.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0351_code_edit_history.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "public"."node_snapshots" WHERE "trigger" = 'pre_code_edit';
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" DROP CONSTRAINT IF EXISTS "node_snapshots_trigger_ck";
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" ADD CONSTRAINT "node_snapshots_trigger_ck" CHECK ("trigger" IN
  ('publish', 'commit', 'manual', 'pre_restore', 'pre_schema', 'pre_delete', 'pre_import', 'nightly',
   'pre_mcp_write'));
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790719260000;
