-- Rollback of 0388_search_tsv_parts: what an operator MAY run before pinning
-- the image one release back (plan v3.2 rule 2, a one-image rollback). Not a
-- migration: nothing runs it on its own.
--
-- Optional: the older image reads nodes.search_tsv the same way whichever
-- expression builds it, so the capped one may stay. This puts the 0000
-- expression back (title at A, the whole data blob at B) and takes 0388 off
-- the ledger, so the next roll forward applies it again. Like 0388 it
-- rewrites the table and rebuilds its indexes (the same time as the roll
-- forward took). It FAILS with 54000 "string is too long for tsvector" while
-- any node holds more than about 1 MB of text: that is the bug 0388 fixes,
-- so on such a box leave 0388 in place.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0388_search_tsv_parts.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."nodes" ALTER COLUMN "search_tsv" SET EXPRESSION AS (
  setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("data"::text, '')), 'B')
);
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792240000000;
