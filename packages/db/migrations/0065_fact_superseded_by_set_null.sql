-- Self-referential `facts.superseded_by` FK was NO ACTION (migration 0015), so
-- deleting a fact that SUPERSEDED an earlier one was blocked while the earlier
-- fact still pointed at it. This bit the node-delete reaper (migration 0059):
-- reaping a node's episodic/factual facts fails with
--   update or delete on table "facts" violates foreign key constraint
--   "facts_superseded_by_fkey"
-- whenever one of those reaped facts is the successor of an older, still-present
-- fact from a *different* source node (the ADD/UPDATE classifier sets
-- older.superseded_by = newer.id; cross-source supersession is normal). Net
-- effect: such a node could not be deleted at all.
--
-- Fix: ON DELETE SET NULL. When a superseding fact is removed, the older fact's
-- back-pointer is simply nulled — it stays retired via its own `valid_to`, it
-- just no longer cites a now-deleted successor. General fix: covers the reaper,
-- FK-cascade, and manual deletes alike.
ALTER TABLE public.facts DROP CONSTRAINT IF EXISTS facts_superseded_by_fkey;
--> statement-breakpoint
ALTER TABLE public.facts
  ADD CONSTRAINT facts_superseded_by_fkey
  FOREIGN KEY (superseded_by) REFERENCES public.facts(id) ON DELETE SET NULL;
