-- Workspaces, W4a fix round 3 (the W4a round 2 re-audit; plan page 4887b8e7,
-- the CEO's W4 decisions of 2026-10-10): the level bridge's heads checks,
-- before heads_check can go 'on'.
--
--  - The apps trigger fires only when the read-only switch really changes
--    (an app settings save that leaves it alone writes no grant and needs no
--    head); an insert keeps its own trigger, unchecked (the node's insert
--    wrote its rows, under its folder's head).
--  - On a brain the workspaces migration skipped (no Admin workspace) the
--    bridge triggers return before they take or check any head: the bridge
--    is inert there, so a miss would be noise and a NOWAIT lock a needless
--    failure.
--
-- DDL and function bodies only; no row is written.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_bridge_upd_stmt_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  me xid8 := pg_current_xact_id_if_assigned();
  ids uuid[];
BEGIN
  IF me IS NULL THEN RETURN NULL; END IF;
  WITH taken AS (
    DELETE FROM "public"."mantle_bridge_pending" p WHERE p."xid" = me RETURNING p."id")
  SELECT array_agg(t."id") INTO ids FROM taken t;
  IF ids IS NULL THEN RETURN NULL; END IF;
  -- Not migrated: the bridge is inert, so nothing is locked or checked.
  IF NOT EXISTS (SELECT 1 FROM "public"."workspaces" w
                  WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'admin') THEN
    RETURN NULL;
  END IF;
  -- A level change or a move rewrites grants: its writer holds the heads
  -- for update (W1; warn mode counts a miss, on mode refuses). A writer that
  -- holds its own heads first also covers the rows whose level follows from
  -- its change: those were found only now, so they are locked here without
  -- waiting (U2, V1: a busy one fails with 55P03 and the writer retries).
  IF cardinality("public"."mantle_heads_held"()) > 0 THEN
    PERFORM "public"."mantle_lock_heads_more"(ids);
  END IF;
  PERFORM "public"."mantle_heads_require"(ids, 'bridge', true);
  PERFORM "public"."mantle_bridge_apply"(ids);
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_upd_stmt_trg"() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."mantle_bridge_app_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "public"."workspaces" w
                  WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."bridge_key" = 'admin') THEN
    RETURN NULL;
  END IF;
  -- An apps row is made with its node, in the node's own insert (createApp
  -- holds the folder's head, share). Only a later read-only switch rewrites
  -- grants of an item that exists, and it needs the item's head.
  IF TG_OP = 'UPDATE' THEN
    PERFORM "public"."mantle_heads_require"(ARRAY[NEW."node_id"], 'bridge', true);
  END IF;
  PERFORM "public"."mantle_bridge_apply"(ARRAY[NEW."node_id"]);
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_bridge_app_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "apps_zz_bridge" ON "public"."apps";
--> statement-breakpoint
CREATE TRIGGER "apps_zz_bridge" AFTER UPDATE OF "data_read_only" ON "public"."apps"
  FOR EACH ROW
  WHEN (OLD."data_read_only" IS DISTINCT FROM NEW."data_read_only")
  EXECUTE FUNCTION "public"."mantle_bridge_app_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "apps_zz_bridge_ins" ON "public"."apps";
--> statement-breakpoint
CREATE TRIGGER "apps_zz_bridge_ins" AFTER INSERT ON "public"."apps"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_bridge_app_trg"();
