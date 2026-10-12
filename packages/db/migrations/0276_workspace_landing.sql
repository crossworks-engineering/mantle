-- Each workspace gets a landing page (task d78e7bde; workspaces arch plan v2,
-- section 21). The landing page is what a login sees at the root of the app
-- while that workspace is the current pick. It is the Built-in home, showing
-- that workspace's data, unless the workspace names a home app here.
--
-- 1. workspaces.landing_app_id: the workspace's home app, or NULL for the
--    Built-in home. A Moderator of the workspace sets it, and only to an app
--    the workspace holds (a grant) with a green published build
--    (server/web/lib/workspaces.ts). The read checks both again on every
--    open, so an app whose build breaks shows the Built-in home instead.
--    No grant is made and none is kept for it (no magic). A deleted app
--    clears it (ON DELETE SET NULL).
-- 2. A workspace that stops holding its home app forgets it (audit M2):
--    a deferred constraint trigger on item_grants clears the pointer at
--    commit when the workspace no longer reads the app (its derived
--    read_ws), whatever path removed the grant: Grant Access, a folder's
--    grants, a move of the home, an archive. Checked at commit, so a path
--    that deletes and adds the same grant back in one transaction keeps
--    it. A later share makes the app held again, never the landing page:
--    only a Moderator picks that.
-- 3. The brain-wide member home app (the anchor's `teamHubAppId`
--    preference) becomes the Team workspace's home app, so nothing is lost.
--    Only an app of the same brain that Team holds is taken (a pointer to
--    an app Team does not hold would come back by itself on a later share).
--    The preference stays as it is: nothing reads it any more, and a
--    rollback finds it unchanged.
--
-- No LLM work is queued and no notify fires: one column, one trigger that
-- writes only workspaces.landing_app_id, and one update of the workspaces
-- table, which has no such trigger.
--
-- Re-runnable: the column is ADD IF NOT EXISTS, the function CREATE OR
-- REPLACE, the trigger dropped and made again, and the update only fills a
-- Team row that has no home app yet.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "public"."workspaces"
  ADD COLUMN IF NOT EXISTS "landing_app_id" uuid
    REFERENCES "public"."nodes"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- The reverse lookup the delete of an app needs (ON DELETE SET NULL).
CREATE INDEX IF NOT EXISTS "workspaces_landing_app_idx"
  ON "public"."workspaces" ("landing_app_id")
  WHERE "landing_app_id" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_ws_landing_held_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  UPDATE "public"."workspaces" w
     SET "landing_app_id" = NULL, "updated_at" = now()
   WHERE w."id" = OLD."workspace_id"
     AND w."landing_app_id" = OLD."node_id"
     AND NOT EXISTS (
       SELECT 1 FROM "public"."nodes" n
        WHERE n."id" = OLD."node_id" AND OLD."workspace_id" = ANY (n."read_ws"));
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_landing_held_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "item_grants_landing_held" ON "public"."item_grants";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "item_grants_landing_held"
  AFTER UPDATE OR DELETE ON "public"."item_grants"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_ws_landing_held_trg"();
--> statement-breakpoint
UPDATE "public"."workspaces" w
   SET "landing_app_id" = n."id", "updated_at" = now()
  FROM "public"."profiles" p, "public"."nodes" n
 WHERE w."bridge_key" = 'team'
   AND w."landing_app_id" IS NULL
   AND p."user_id" = w."owner_id"
   AND n."id"::text = lower(btrim(p."preferences"->>'teamHubAppId'))
   AND n."owner_id" = w."owner_id"
   AND n."type" = 'app'
   AND w."id" = ANY (n."read_ws");
