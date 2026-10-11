-- Workspaces W6a fix round 1 (plan page 4887b8e7, sections 2.3, 11 and 14).
--
--  1. Mail rows: public.emails and public.email_attachments are granted to
--     the workspace role (mantle_view_user, access-matrix.ts) but had no row
--     rule. Row level security on; an email shows when its item does (the
--     nodes rule) or the scope holds the Admin workspace (mail is an Admin
--     kind); an attachment follows its email.
--  2. item_marks: a login's pins and opens are its own. The rule now also
--     asks actor_id = the scope's login (0265 followed the item only).
--  3. traces: the login's own turns, or the traces of a workspace the scope
--     moderates (an unstamped trace, system work, is the Admin workspace's:
--     its Moderators). 0265 showed every trace of a workspace in the scope.
--  4. Creates and deletes under a scope. An Admin user's mutating request
--     sets mantle.ws and mantle.mod_ws on its system transactions
--     (withSystemTx, @mantle/db), so mantle_scope_active() is on there and
--     the 0241/0245 move checks run. Two more checks run the same way: a new
--     item in a folder needs mantle_may_edit on the folder, and deleting an
--     item needs mantle_may_manage on its home. Only statements the caller
--     ran (trigger depth 1): rows a trigger or a cascade writes follow the
--     row that was checked. With no scope set (workers, system work, the
--     owner paths on a brain not on workspaces) nothing changes.
--  5. profiles (fix round 2): the workspace role reads its own login's row,
--     the brain's row, or every row when the scope holds Admin.
--
-- Idempotent.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."emails" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."email_attachments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "emails_user_read" ON "public"."emails";
--> statement-breakpoint
CREATE POLICY "emails_user_read" ON "public"."emails" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "emails"."node_id")
         OR (SELECT "public"."mantle_scope_is_admin"()));
--> statement-breakpoint
DROP POLICY IF EXISTS "email_attachments_user_read" ON "public"."email_attachments";
--> statement-breakpoint
CREATE POLICY "email_attachments_user_read" ON "public"."email_attachments" FOR SELECT TO mantle_view_user
  USING (EXISTS (SELECT 1 FROM "public"."emails" e WHERE e.id = "email_attachments"."email_id"));
--> statement-breakpoint
DROP POLICY IF EXISTS "item_marks_user_read" ON "public"."item_marks";
--> statement-breakpoint
CREATE POLICY "item_marks_user_read" ON "public"."item_marks" FOR SELECT TO mantle_view_user
  USING ("actor_id" = (SELECT "public"."mantle_login_id"())
         AND EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "item_marks"."node_id"));
--> statement-breakpoint
DROP POLICY IF EXISTS "traces_user_read" ON "public"."traces";
--> statement-breakpoint
CREATE POLICY "traces_user_read" ON "public"."traces" FOR SELECT TO mantle_view_user
  USING ("login_id" = (SELECT "public"."mantle_login_id"())
         OR ARRAY["workspace_id"] && (SELECT "public"."mantle_scope_mod_ws"())
         OR ("workspace_id" IS NULL AND EXISTS (
               SELECT 1 FROM "public"."workspaces" w
                WHERE w."is_admin" AND w."archived_at" IS NULL
                  AND w."id" = ANY ("public"."mantle_scope_mod_ws"()))));
--> statement-breakpoint
-- 4a. A new item in a folder: the scope may edit the folder.
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_scope_create_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  f record;
BEGIN
  IF pg_trigger_depth() > 1 OR NOT "public"."mantle_scope_active"() THEN
    RETURN NEW;
  END IF;
  SELECT n."id", n."home_ws", n."write_ws" INTO f
    FROM "public"."nodes" n
   WHERE n."id" = "public"."mantle_parent_folder"(NEW."owner_id", NEW."type", NEW."path");
  IF FOUND AND NOT coalesce("public"."mantle_may_edit"(f."home_ws", f."write_ws"), false) THEN
    RAISE EXCEPTION 'not allowed to add items to that folder' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_scope_create_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_scope_create" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_scope_create" BEFORE INSERT ON "public"."nodes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_nodes_scope_create_trg"();
--> statement-breakpoint
-- 4b. Deleting an item: the scope manages its home (a Moderator of it). A
-- row with no home (a personal item, derived rows) is not a workspace item.
CREATE OR REPLACE FUNCTION "public"."mantle_nodes_scope_delete_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR NOT "public"."mantle_scope_active"() THEN
    RETURN OLD;
  END IF;
  IF OLD."home_ws" IS NOT NULL AND NOT "public"."mantle_may_manage"(OLD."home_ws") THEN
    RAISE EXCEPTION 'not allowed to delete this item' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_nodes_scope_delete_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_scope_delete" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_scope_delete" BEFORE DELETE ON "public"."nodes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_nodes_scope_delete_trg"();
--> statement-breakpoint
-- 5. profiles (fix round 2, L-d): the workspace role read every login's
--    row. It now reads its login's own row, the brain's row (the brain-wide
--    settings every turn and screen reads: time zone, site name, look), or
--    every row when the scope holds the Admin workspace. The level roles
--    keep every row (their rule is all-rows): a policy of their own, now
--    that row level security is on.
ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "profiles_level_read" ON "public"."profiles";
--> statement-breakpoint
CREATE POLICY "profiles_level_read" ON "public"."profiles" FOR SELECT
  TO mantle_view_team, mantle_view_client, mantle_view_public
  USING (true);
--> statement-breakpoint
DROP POLICY IF EXISTS "profiles_user_read" ON "public"."profiles";
--> statement-breakpoint
CREATE POLICY "profiles_user_read" ON "public"."profiles" FOR SELECT TO mantle_view_user
  USING ("user_id" = (SELECT "public"."mantle_login_id"())
         OR "user_id" = (SELECT "public"."mantle_brain_id"())
         OR (SELECT "public"."mantle_scope_is_admin"()));
