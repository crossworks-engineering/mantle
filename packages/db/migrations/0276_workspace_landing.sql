-- Each workspace gets a landing page (task d78e7bde; workspaces arch plan v2,
-- section 21). The landing page is what a login sees at the root of the app
-- while that workspace is the current pick. It is the Built-in home, showing
-- that workspace's data, unless the workspace names a home app here.
--
-- 1. workspaces.landing_app_id: the workspace's home app, or NULL for the
--    Built-in home. A Moderator of the workspace sets it, and only to an app
--    the workspace holds (a grant) with a green published build
--    (server/web/lib/workspaces.ts). The read checks both again on every
--    open, so an app that loses its grant or its build shows the Built-in
--    home instead. No grant is made and none is kept for it (no magic).
--    A deleted app clears it (ON DELETE SET NULL).
-- 2. The brain-wide member home app (the anchor's `teamHubAppId`
--    preference) becomes the Team workspace's home app, so nothing is lost.
--    Only an app of the same brain is taken. The preference stays as it is:
--    nothing reads it any more, and a rollback finds it unchanged.
--
-- No LLM work is queued and no notify fires: one column and one update of
-- the workspaces table, which has no such trigger.
--
-- Re-runnable: the column is ADD IF NOT EXISTS, and the update only fills a
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
UPDATE "public"."workspaces" w
   SET "landing_app_id" = n."id", "updated_at" = now()
  FROM "public"."profiles" p, "public"."nodes" n
 WHERE w."bridge_key" = 'team'
   AND w."landing_app_id" IS NULL
   AND p."user_id" = w."owner_id"
   AND n."id"::text = lower(btrim(p."preferences"->>'teamHubAppId'))
   AND n."owner_id" = w."owner_id"
   AND n."type" = 'app';
