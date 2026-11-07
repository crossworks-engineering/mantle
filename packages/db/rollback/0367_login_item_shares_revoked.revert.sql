-- Rollback of 0367_login_item_shares_revoked: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- It takes 0367 off the ledger, so the next roll forward runs it again. The
-- shares 0367 revoked stay revoked: no record says which they were, and a
-- revoked share is never live again on any image (a revoke is final, as the
-- person's own). No row changes.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0367_login_item_shares_revoked.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791583623000;
