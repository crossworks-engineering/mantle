-- Rollback of 0354_peer_status_link: what an operator MUST run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Required: the older image never reads access_scope, so a status-only
-- peer's token would be an ordinary peer token there, and an outbound-only
-- peer's token would verify again on the federation routes. This revert
-- closes every peer that is not 'full' (enabled off, status revoked: both
-- directions stop); the owner links them again after the roll forward. The
-- columns and their CHECK stay (the older image never names them, and an
-- insert takes their defaults), so a roll forward keeps each peer's scope.
-- Then it takes 0354 off the ledger, so the next roll forward runs it
-- again (ADD COLUMN IF NOT EXISTS keeps the columns; the CHECK is dropped
-- and made again).
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0354_peer_status_link.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."mantle_peers"
   SET "enabled" = false, "status" = 'revoked', "updated_at" = now()
 WHERE "access_scope" <> 'full';
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790978460000;
