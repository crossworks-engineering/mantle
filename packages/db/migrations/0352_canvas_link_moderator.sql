-- A Present canvas's open link is its home Moderators', as an app's (owner
-- decision 2026-11-02): the edit check's `link` and `link_close` needs ask
-- manage of the home for both kinds, else edit. The kinds are named once
-- here, in mantle_link_needs_manage, the SQL twin of the registry's
-- `publicLink: 'moderator'` (packages/client-types/src/kinds.ts,
-- linkNeedsModerator); a db test holds the two to the same set.
--
-- mantle_check_row is 0280's, with only the two `link` arms changed. A link
-- made before stays live: nothing here touches the shares rows.
-- No new table, no trigger, no LLM work.
-- Revert: packages/db/rollback/0352_canvas_link_moderator.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_link_needs_manage"(kind "public"."node_type")
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(kind IN ('app', 'present'), false)
$$;
--> statement-breakpoint
-- What the scope may do with an item of this home and these workspaces.
-- `kind` and `informational` matter only to link (an app's or a canvas's
-- link needs manage, mantle_link_needs_manage) and appdata (Informational:
-- an Admin scope too, D6).
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
    WHEN 'link' THEN CASE WHEN "public"."mantle_link_needs_manage"(kind)
                          THEN "public"."mantle_may_manage_home"(home)
                          ELSE coalesce("public"."mantle_may_edit"(home, write_ws), false) END
    WHEN 'link_close' THEN (CASE WHEN "public"."mantle_link_needs_manage"(kind)
                                 THEN "public"."mantle_may_manage_home"(home)
                                 ELSE coalesce("public"."mantle_may_edit"(home, write_ws), false) END)
                           OR "public"."mantle_scope_has_area"('users')
    ELSE NULL
  END;
END
$$;
--> statement-breakpoint
-- As 0280 left it: no role runs it but through its callers.
REVOKE ALL ON FUNCTION "public"."mantle_check_row"(uuid, uuid[], uuid[], text, "public"."node_type", boolean) FROM PUBLIC;
