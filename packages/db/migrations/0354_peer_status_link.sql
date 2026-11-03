-- The status link (docs/federation.md "Status links"): a peer's inbound
-- token may be narrowed to this box's status numbers, or closed, and the
-- peer may be marked as one this box watches.
--
-- mantle_peers.access_scope: what the peer's inbound token may do here.
--   'full'   as before: the federation read routes, and /api/mcp as the
--            login it acts as (Acts as), with its Write switch and risky tools.
--   'status' /api/mcp lists and calls the status tools only (box_status,
--            brain_capacity), whatever else the row says; never the
--            federation read routes.
--   'none'   the inbound token verifies nowhere: an outbound-only peer (the
--            watching side of a status link).
-- Any other value is refused by the CHECK, and the code reads an unknown
-- value as no access at all (fail closed).
--
-- mantle_peers.watch_status: peer_status polls this peer's box_status when
-- it is called with no peer named.
--
-- Every existing peer keeps 'full' and false: nothing changes for it.
-- Grants come from the access matrix, never from here: both columns are
-- written at the full-route spot peer-access only, as status and enabled are.
--
-- Additive: two columns with constant defaults (no table rewrite), one
-- CHECK, no trigger, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0354_peer_status_link.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."mantle_peers"
  ADD COLUMN IF NOT EXISTS "access_scope" text DEFAULT 'full' NOT NULL,
  ADD COLUMN IF NOT EXISTS "watch_status" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."mantle_peers" DROP CONSTRAINT IF EXISTS "mantle_peers_access_scope_ck";
--> statement-breakpoint
ALTER TABLE "public"."mantle_peers"
  ADD CONSTRAINT "mantle_peers_access_scope_ck"
  CHECK ("access_scope" IN ('full', 'status', 'none'));
