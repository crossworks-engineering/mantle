-- Validate the nodes.owner_id -> spaces foreign key added NOT VALID in 0165,
-- in this migration's own transaction: the scan takes a SHARE UPDATE
-- EXCLUSIVE lock (reads and writes go on), never the short exclusive lock of
-- the constraint swap (plan 11: NOT VALID, then VALIDATE with lock_timeout).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."nodes" VALIDATE CONSTRAINT "nodes_owner_space_fk";
