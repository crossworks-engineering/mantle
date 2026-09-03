-- Make the external-calendar dedup key a real constraint.
--
-- `upsertExternalEvent` reads then writes: SELECT the event node for (owner,
-- external_account_id, external_uid), UPDATE it if found, INSERT if not. With
-- no unique index that is a check-then-act race, and calendar sync is exactly
-- the workload that runs it concurrently — a scheduled sync overlapping a
-- manual one, or a retried job — so both callers miss the row and both insert.
-- The duplicate is invisible in the feed (upstream still has one event) and
-- permanent in the brain: it shows twice in the calendar, is embedded twice,
-- and answers twice in retrieval.
--
-- The index has been the fix all along; the reason it was not applied is that
-- CREATE UNIQUE INDEX fails outright on a box that already holds duplicates,
-- which is every box the race ever hit. So dedupe first, in the same
-- transaction, and let the constraint hold from then on.
--
-- WHICH ROW SURVIVES: the one with an embedding, then the most recently
-- updated, then lowest id. An extracted row carries real work (an LLM summary
-- and a vector) and is what search already returns; the copies are the ones the
-- syncs stopped maintaining. This is only safe to delete at all because these
-- nodes are DERIVED — the feed is the source of truth, and the next sync
-- rebuilds anything wrongly removed.
--
-- Deleting a node here is fully cleaned up by machinery that already exists:
-- content_chunks cascade (0040), facts.source_node_id is ON DELETE SET NULL
-- (0015), and entity_edges — which has no FK — is reaped by the AFTER DELETE
-- trigger from 0058, which fires on direct SQL deletes too.
CREATE TEMP TABLE "_dupe_external_events" ON COMMIT DROP AS
SELECT id
FROM (
  SELECT id,
         row_number() OVER (
           PARTITION BY "owner_id",
                        ("data"->>'external_account_id'),
                        ("data"->>'external_uid')
           ORDER BY ("embedding" IS NOT NULL) DESC, "updated_at" DESC, id ASC
         ) AS rn
  FROM "nodes"
  WHERE "type" = 'event'
    AND ("data"->>'external_uid') IS NOT NULL
    AND ("data"->>'external_account_id') IS NOT NULL
) ranked
WHERE rn > 1;
--> statement-breakpoint

DELETE FROM "nodes" WHERE id IN (SELECT id FROM "_dupe_external_events");
--> statement-breakpoint

-- Superseded by the unique index below, which leads with the same two columns
-- plus the account. Every caller (upsertExternalEvent, listExternalEventUids,
-- deleteExternalEvents, deleteAllExternalEvents) filters by
-- external_account_id, so nothing looked up a uid without one and nothing
-- loses its index.
DROP INDEX IF EXISTS "nodes_event_external_uid_idx";
--> statement-breakpoint

-- Partial on purpose: native events carry no external_uid, and hundreds of them
-- per owner would collide on NULL under a plain unique index.
CREATE UNIQUE INDEX "nodes_event_external_uid_uq"
  ON "nodes" ("owner_id", (("data"->>'external_account_id')), (("data"->>'external_uid')))
  WHERE "type" = 'event'
    AND ("data"->>'external_uid') IS NOT NULL
    AND ("data"->>'external_account_id') IS NOT NULL;
