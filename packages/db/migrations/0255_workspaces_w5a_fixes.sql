-- Workspaces, phase W5a fix round 1 (plan page 4887b8e7, sections 15, 18.8;
-- the W5a audit, items M3 and L3).
--
-- M3: a workspace name is no longer unique across the brain. The old index
-- (0241) answered "name taken" for a workspace the caller cannot see, which
-- told a member that a private workspace of that name exists. Only the names
-- of the Admin and Team workspaces stay reserved: everybody knows those two
-- exist, so refusing them leaks nothing. Archived workspaces never clash.
--
-- L3: an archived workspace takes no grants. Archive drops the workspace's
-- grants while it holds the workspace row FOR UPDATE; a grant written at the
-- same time on another connection could land after the drop. The trigger
-- below reads the workspace row FOR KEY SHARE, which waits for that lock, and
-- then sees archived_at as committed. A grant written first holds the same
-- share lock, so the archive waits for it and drops it. A direct grant to an
-- archived workspace is refused; a folder-derived row is skipped (fix round
-- 2, L-1), so a create or move that raced the archive still succeeds.
--
-- Small table (workspaces) and a new trigger: plain DDL. Nothing here writes
-- a grant, starts LLM work or notifies the extractor.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "public"."workspaces_live_name_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_reserved_name_uq"
  ON "public"."workspaces" ("owner_id", lower(btrim("name")))
  WHERE "archived_at" IS NULL AND lower(btrim("name")) IN ('admin', 'team');
--> statement-breakpoint

-- Hardening (fix round 3): a home row is never folder-derived. Every writer
-- of a home today clears via_folder_id (the bridge), and the archive trigger
-- below skips derived rows, so a derived home could vanish. A plain ADD:
-- the migration runs in one transaction, so a separate VALIDATE would scan
-- under the same lock anyway, and item_grants is small (thousands of rows
-- on the dev and bible copies; lock_timeout above bounds the wait).
ALTER TABLE "public"."item_grants"
  DROP CONSTRAINT IF EXISTS "item_grants_home_not_derived_ck";
--> statement-breakpoint
ALTER TABLE "public"."item_grants"
  ADD CONSTRAINT "item_grants_home_not_derived_ck"
  CHECK (NOT ("is_home" AND "via_folder_id" IS NOT NULL));
--> statement-breakpoint

-- SECURITY DEFINER with a pinned search_path, as every grant trigger: the
-- writer's role may lack UPDATE on workspaces (FOR KEY SHARE needs it) and
-- its row security may hide the row.
CREATE OR REPLACE FUNCTION "public"."mantle_item_grants_live_ws_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  archived timestamptz;
BEGIN
  SELECT w."archived_at" INTO archived
    FROM "public"."workspaces" w
   WHERE w."id" = NEW."workspace_id"
     FOR KEY SHARE;
  IF archived IS NOT NULL THEN
    -- A row a folder derives (0251: a new item placed in the folder, or a
    -- re-derive after a move) read the folder's grant before the archive
    -- dropped it. Skip that row: the user's create or move goes on, and the
    -- archived workspace gains nothing. Only a direct grant is refused.
    IF NEW."via_folder_id" IS NOT NULL THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'workspace % is archived: it takes no grants', NEW."workspace_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- A trigger function only: nobody calls it (audit M1 of W1).
REVOKE EXECUTE ON FUNCTION "public"."mantle_item_grants_live_ws_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "item_grants_live_ws" ON "public"."item_grants";
--> statement-breakpoint
CREATE TRIGGER "item_grants_live_ws"
  BEFORE INSERT OR UPDATE ON "public"."item_grants"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_item_grants_live_ws_trg"();
