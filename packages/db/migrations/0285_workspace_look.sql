-- Each workspace gets a look (task 5edc9149): a colour and an icon, chosen
-- on the workspace screen the way a folder's are, and shown in the
-- workspace switcher and on the folder tree's share marks.
--
-- 1. workspaces.color: a tint key of the folder palette (APP_TINTS in
--    @mantle/client-types/app-nav), never a colour value: each theme draws
--    its own. NULL = the neutral default.
-- 2. workspaces.icon: an emoji or `lucide:<name>`, the folder icon
--    vocabulary. NULL = the default icon of the workspace's kind, which the
--    client picks.
-- 3. mantle_ws_kind(ws): the kind a default icon is picked by: 'admin' (the
--    Admin workspace), 'team' (the Team workspace), 'private' (a login's
--    private workspace) or 'other'. A definer function because a private
--    workspace is known only by private_workspaces, which the workspace
--    role does not read; it answers only for a workspace of this brain
--    (mantle_brain_id) that the scope may name (one of the scope's, any
--    for an Admin scope or with no scope set, as mantle_ws_nameable
--    without a `via`), else NULL. A kind only: no name,
--    no login. The write role takes the right with the workspace role's
--    (access-matrix.ts, the function rights sync), and the public demo's
--    reader is granted it too (its owner reads draw the chips). Never
--    PUBLIC.
--
-- Who sets the look is the rule that renames a workspace: a Moderator of it
-- or an Admin user (server/web/lib/workspaces.ts, patchWorkspace). The
-- values are checked there with the folder's own validators; the database
-- keeps no list of tints, so a new tint needs no migration.
--
-- Two nullable columns with no default: no table rewrite, no backfill, no
-- trigger, no LLM work. The lock is taken first and never waited for past
-- 30 s behind live traffic (as 0283): the migration fails and is retried
-- rather than queueing every reader behind it. Re-runnable: ADD IF NOT
-- EXISTS and CREATE OR REPLACE.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."workspaces"
  ADD COLUMN IF NOT EXISTS "color" text,
  ADD COLUMN IF NOT EXISTS "icon" text;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_ws_kind"(ws uuid)
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT CASE
           WHEN w."is_admin" THEN 'admin'
           WHEN w."bridge_key" = 'team' THEN 'team'
           WHEN EXISTS (SELECT 1 FROM "public"."private_workspaces" p
                         WHERE p."workspace_id" = w."id") THEN 'private'
           ELSE 'other'
         END
    FROM "public"."workspaces" w
   WHERE w."id" = ws AND w."owner_id" = "public"."mantle_brain_id"()
     AND (NOT "public"."mantle_scope_active"()
          OR ws = ANY ("public"."mantle_scope_ws"())
          OR "public"."mantle_scope_has_admin"())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_ws_kind"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_ws_kind"(uuid) TO "mantle_view_user";
--> statement-breakpoint
-- The public demo's SELECT-only reader serves owner reads (the tree's
-- chips): it gets the same, as it got mantle_brain_team_ws (0256).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_ws_kind"(uuid) TO demo_reader;
  END IF;
END
$$;
