-- Recall R5: retire the page-built (v1) maps.
--
-- A page-built map was compiled from a `recall`-tagged page tree: its
-- recall_maps row has node_id NULL and the root page's id as its id. R5
-- removes the compiler, the page hooks and every read of such a row (the
-- serving tools, the owner API and the write path all require node_id now),
-- so any row left is dead weight. This deletes them; their cards go with them
-- (recall_nodes.map_id ON DELETE CASCADE, migration 0203).
--
-- This is the cleanup for leftovers, not the retirement itself. On dev the
-- four v1 maps are retired BEFORE this release is rolled: their slugs move to
-- the native maps and their roots are untagged while the v1 code still runs,
-- and untagging a root removes its compiled map through the v1 hooks. So on
-- a box where that was done, this finds nothing. Only dev and jason-prod ever
-- had v1 maps (Jason, 2026-09-30: "not used anymore").
--
-- PRE-ROLL CHECK on each box (docs/update-prod.md): run
--   select slug, title from recall_maps where node_id is null;
-- and roll only when it returns zero rows, or every slug it lists is answered
-- by a native map (its current slug or one of its former_slugs). A slug that
-- nothing answers stops resolving for every agent and skill that remembers it.
-- The NOTICE below puts the count and the slugs in the roll log.
--
-- Rollback: one-way for the deleted rows (they were compiled from pages, and
-- the previous release recompiles a map on the next commit to a page in a
-- still-tagged tree). The schema is unchanged: last_compile_ok and
-- last_compile_report stay, unused, so the previous release still runs on
-- this table; a later migration drops them.
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
