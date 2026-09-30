-- Recall R5: retire the page-built (v1) maps.
--
-- A page-built map was compiled from a `recall`-tagged page tree: its
-- recall_maps row has node_id NULL and the root page's id as its id. R5
-- removes the compiler, the page hooks and every read of such a row (the
-- serving tools, the owner API and the write path all require node_id now),
-- so any row left is dead weight. This deletes them; their cards go with them
-- (recall_nodes.map_id ON DELETE CASCADE, migration 0203).
--
-- This is the cleanup for leftovers, not the retirement itself: from the
-- moment the R5 code runs, no page-built map is served, whether or not this
-- has run. The retirement is done by hand BEFORE this release reaches a box,
-- on a release that still has the v1 code: untag the map's root (the v1
-- hooks drop its compiled map and free its slug), then give the native map
-- the old slug as a former slug. On dev that is four maps
-- (mantle-registry-start-here, mantle-status-workflow, jackdaw-ui-standards,
-- recall-workshop-test-map); jason-prod has one test map.
--
-- PRE-ROLL CHECK on each box (docs/update-prod.md; scripts/roll.sh refuses a
-- box that fails it): select slug, title from recall_maps where node_id is
-- null; must return ZERO rows. No other state passes: while a v1 row exists,
-- no native map can hold its slug. The NOTICE below puts the count and the
-- slugs in the roll log.
--
-- ORDER: this `when` (1790018820000) is above 0208's. A database that
-- applies this before 0208 skips 0208 for ever (the runner applies only
-- entries above the highest applied `when`), so 0208 must be on a box first.
--
-- Rollback: one-way for the deleted rows. The schema is unchanged:
-- last_compile_ok and last_compile_report stay, unused, so the previous
-- release still runs on this table. Under that release the `recall` and
-- `prompt` page tags are live again, so untag them before rolling back
-- (docs/update-prod.md). The follow-up migration that drops last_compile_*
-- repeats this delete and sets node_id NOT NULL.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $$
DECLARE
  n integer;
  slugs text;
BEGIN
  SELECT count(*), coalesce(string_agg(slug, ', ' ORDER BY slug), '')
    INTO n, slugs
    FROM recall_maps
   WHERE node_id IS NULL;
  RAISE NOTICE 'recall R5: deleting % page-built map(s): %', n, slugs;
END $$;
--> statement-breakpoint
DELETE FROM recall_maps WHERE node_id IS NULL;
