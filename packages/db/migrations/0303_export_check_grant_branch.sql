-- Hotfix S11a-7 (written up at the end of docs/_archive/plan-v3-s3-handover.md):
-- a new app_table_exports row was refused in `on` for every scoped caller, the
-- app's Moderator and the owner on an app homed in Admin too (42501 "not
-- allowed to grant to that workspace"; in off and warn the miss "INSERT on
-- app_table_exports: not a Moderator of the workspace"). So
-- app_table_export_set made no new link anywhere once the actor check was on.
--
-- The cause: the access matrix gives app_table_exports the write check
-- `manage` of app_node_id (S3, 0302). mantle_write_check_trg (0281's body)
-- has, after the per-row loop, a branch for `manage` written for grant rows
-- (item_grants): a new grant, one moved to another workspace, or one made
-- the home needs a Moderator of its workspace. It reads the row's
-- workspace_id. An export row has no such column, so the target was NULL
-- and the INSERT always refused.
--
-- The fix: 0281's body unchanged, except that the grant branch runs only on
-- a row that carries a workspace_id. The per-row loop (manage of the app,
-- or an Admin scope for an app with no home) still decides an export row,
-- and the row rule (0302) and the edit check (edit of the linked Table)
-- are untouched. The matrix's two `manage` tables: item_grants (has
-- workspace_id: same answers as before) and app_table_exports (now asked
-- the loop alone). No row is touched; no trigger is made or moved.
--
-- Re-runnable. The `when` sits between 0302's and the next one's.
CREATE OR REPLACE FUNCTION "public"."mantle_write_check_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  kind text := TG_ARGV[0];
  col text := TG_ARGV[1];
  seen jsonb[] := ARRAY[]::jsonb[];
  r jsonb;
  item uuid;
  n record;
  f record;
  ok boolean;
  ws uuid[];
  generated text[];
  target uuid;
BEGIN
  IF kind = 'self' THEN
    IF TG_OP = 'INSERT' THEN
      IF NOT "public"."mantle_may_add_to_folder"(NEW."owner_id", NEW."type", NEW."path") THEN
        RAISE EXCEPTION 'not allowed to add items to that folder' USING ERRCODE = '42501';
      END IF;
      IF NOT "public"."mantle_may_create_item"(NEW."owner_id", NEW."type", NEW."path")
         AND "public"."mantle_scoped_write_refuses"('INSERT on nodes: no Moderator of the home') THEN
        RAISE EXCEPTION 'not allowed to create an item in that workspace' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW."type" IS DISTINCT FROM OLD."type"
         AND "public"."mantle_scoped_write_refuses"('UPDATE on nodes: a change of kind') THEN
        RAISE EXCEPTION 'not allowed to change the kind of this item' USING ERRCODE = '42501';
      END IF;
      ok := "public"."mantle_check_row"(OLD."home_ws", OLD."write_ws", OLD."read_ws", 'edit');
      IF NOT ok THEN
        -- A change of the presentation keys alone (a board rank): edit of
        -- the item or of its folder. Stored generated columns are not
        -- computed yet in a BEFORE trigger's NEW: left out of the comparison.
        generated := ARRAY(SELECT a."attname"::text FROM pg_attribute a
                            WHERE a."attrelid" = TG_RELID AND a."attgenerated" <> '');
        IF (to_jsonb(NEW) - generated - 'data' - 'updated_at')
             = (to_jsonb(OLD) - generated - 'data' - 'updated_at')
           AND (coalesce(NEW."data", '{}'::jsonb) - "public"."mantle_node_presentation_keys"())
               = (coalesce(OLD."data", '{}'::jsonb) - "public"."mantle_node_presentation_keys"()) THEN
          SELECT p."home_ws", p."write_ws", p."read_ws" INTO f FROM "public"."nodes" p
           WHERE p."id" = "public"."mantle_parent_folder"(OLD."owner_id", OLD."type", OLD."path");
          ok := FOUND AND "public"."mantle_check_row"(f."home_ws", f."write_ws", f."read_ws", 'edit');
        END IF;
      END IF;
      IF NOT ok AND "public"."mantle_scoped_write_refuses"('UPDATE on nodes: no edit of the item') THEN
        RAISE EXCEPTION 'not allowed to edit this item' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
      IF OLD."home_ws" IS NULL AND NOT "public"."mantle_may_manage_home"(NULL)
         AND "public"."mantle_scoped_write_refuses"('DELETE on nodes: no home, no Admin scope') THEN
        RAISE EXCEPTION 'not allowed to delete this item' USING ERRCODE = '42501';
      END IF;
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN seen := seen || to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN seen := seen || to_jsonb(NEW); END IF;
  FOREACH r IN ARRAY seen LOOP
    item := (r ->> col)::uuid;
    IF item IS NULL THEN
      -- A row of no item: inside the scope, and the caller's own.
      IF kind = 'manage' OR NOT (r ? 'read_ws') THEN
        ok := false;
      ELSE
        ws := ARRAY(SELECT jsonb_array_elements_text(r -> 'read_ws'))::uuid[];
        ok := ws <@ "public"."mantle_scope_ws"()
              AND coalesce((r ->> 'login_id')::uuid = "public"."mantle_login_id"(), false);
      END IF;
    ELSE
      SELECT x."home_ws", x."write_ws", x."read_ws" INTO n FROM "public"."nodes" x WHERE x."id" = item;
      IF NOT FOUND THEN
        ok := true; -- no such item: its foreign key refuses the row
      ELSE
        ok := "public"."mantle_check_row"(n."home_ws", n."write_ws", n."read_ws",
                                          CASE WHEN kind = 'manage' THEN 'manage' ELSE 'edit' END);
      END IF;
    END IF;
    IF NOT ok AND "public"."mantle_scoped_write_refuses"(
         format('%s on %s: no %s of the item', TG_OP, TG_TABLE_NAME, kind)) THEN
      RAISE EXCEPTION 'not allowed to change this item' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- A new grant, one moved to another workspace, or one made the home: a
  -- Moderator of its workspace. Grant rows only (S11a-7): a `manage` row
  -- with no workspace_id (an export row) is decided by the loop above.
  IF kind = 'manage' AND TG_OP IN ('INSERT', 'UPDATE') AND to_jsonb(NEW) ? 'workspace_id' THEN
    target := (to_jsonb(NEW) ->> 'workspace_id')::uuid;
    IF (TG_OP = 'INSERT'
        OR target IS DISTINCT FROM (to_jsonb(OLD) ->> 'workspace_id')::uuid
        OR (coalesce((to_jsonb(NEW) ->> 'is_home')::boolean, false)
            AND NOT coalesce((to_jsonb(OLD) ->> 'is_home')::boolean, false)))
       AND NOT coalesce(target = ANY ("public"."mantle_scope_mod_ws"()), false)
       AND "public"."mantle_scoped_write_refuses"(
             format('%s on %s: not a Moderator of the workspace', TG_OP, TG_TABLE_NAME)) THEN
      RAISE EXCEPTION 'not allowed to grant to that workspace' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_write_check_trg"() FROM PUBLIC;
