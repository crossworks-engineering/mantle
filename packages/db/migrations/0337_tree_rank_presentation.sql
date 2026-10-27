-- The tree's custom order (docs/folder-tree.md, "Custom order"): an item's
-- place in its folder is `tree_rank`, a presentation key of its own beside
-- `rank` (a task's board order, a folder's place among its siblings). A
-- change of these keys alone needs edit of the item OR of its folder (0281:
-- the write check's exemption), so Write on a folder orders what it holds.
-- Its own key, so a board drag never reorders the tree and a tree place
-- never moves a card on a board.
--
-- Only the list changes (CREATE OR REPLACE, the same signature): every
-- check that reads it (mantle_write_check_trg, the edit check's keys) is
-- untouched. Re-runnable.
--
-- Rollback: packages/db/rollback/0337_tree_rank_presentation.revert.sql puts
-- 0281's list back; the older image never writes tree_rank.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_node_presentation_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['rank', 'tree_rank']::text[]
$$;
