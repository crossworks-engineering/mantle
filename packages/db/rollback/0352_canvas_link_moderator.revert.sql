-- Rollback of 0352_canvas_link_moderator: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- It puts back 0280's mantle_check_row (an app's link needs manage, a
-- canvas's edit), drops mantle_link_needs_manage, and takes 0352 off the
-- ledger, so the next roll forward runs it again. No row changes.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0352_canvas_link_moderator.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_check_row"(
  home uuid, write_ws uuid[], read_ws uuid[], need text,
  kind "public"."node_type" DEFAULT NULL, informational boolean DEFAULT false)
  RETURNS boolean LANGUAGE plpgsql STABLE
  SET search_path = "public", pg_temp AS $$
BEGIN
  RETURN CASE need
    WHEN 'read' THEN coalesce(read_ws && "public"."mantle_scope_ws"(), false)
    WHEN 'edit' THEN coalesce("public"."mantle_may_edit"(home, write_ws), false)
    WHEN 'manage' THEN "public"."mantle_may_manage_home"(home)
    WHEN 'admin' THEN "public"."mantle_scope_has_admin"()
    WHEN 'appdata' THEN coalesce("public"."mantle_may_edit"(home, write_ws), false)
                        AND (NOT coalesce(informational, false) OR "public"."mantle_scope_has_admin"())
    WHEN 'link' THEN CASE WHEN kind = 'app' THEN "public"."mantle_may_manage_home"(home)
                          ELSE coalesce("public"."mantle_may_edit"(home, write_ws), false) END
    WHEN 'link_close' THEN (CASE WHEN kind = 'app' THEN "public"."mantle_may_manage_home"(home)
                                 ELSE coalesce("public"."mantle_may_edit"(home, write_ws), false) END)
                           OR "public"."mantle_scope_has_area"('users')
    ELSE NULL
  END;
END
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_link_needs_manage"("public"."node_type");
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790805660000;
