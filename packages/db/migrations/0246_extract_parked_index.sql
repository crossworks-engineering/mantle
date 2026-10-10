-- W1 audit fix round 2 (LOW 2): the parked-extraction count the push worker
-- reads on every needs-you event (@mantle/db extract-parked.ts) scanned every
-- brain node. A partial index holds only the parked rows (normally none).
--
-- Lock cost: a plain CREATE INDEX (a migration runs in a transaction, so not
-- CONCURRENTLY) takes a SHARE lock on nodes for the build: reads go on,
-- writes to nodes wait while one pass over the table runs (well under a
-- second on dev; a few seconds on the largest box). The lock wait itself is
-- capped below; on a timeout the migration fails and is re-runnable.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nodes_extract_parked_idx"
  ON "public"."nodes" ("owner_id") WHERE "data" ? 'extract_parked';
