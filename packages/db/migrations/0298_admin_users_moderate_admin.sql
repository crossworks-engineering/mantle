-- Every Admin user is a Moderator of the Admin workspace, always (owner
-- decision, F4 fix round 1). The login bridge (mantle_bridge_login, last
-- 0286) already makes an admin login a Moderator when it joins Admin; until
-- now an Admin user could take the tick away (PATCH
-- /api/workspaces/:id/users/:loginId, or an add to Admin with the tick
-- off), and such a user had no Moderator seat in Admin: its edits of
-- Admin-homed items and its creates into Admin were refused on the write
-- role (F4). The workspace screen now refuses both (server/web
-- lib/workspaces.ts: 409 admin_workspace); this ticks every user of a live
-- or archived Admin workspace whose login is an admin and who is not a
-- Moderator there, one workspace_events row each (user.moderator, no actor,
-- `by` naming this migration), as the ticks commands of 0286 log theirs.
--
-- No other row changes; a login that is not an admin is left as it is (the
-- bridge keeps such a login out of Admin). No LLM work, no notify.
-- Re-runnable: a second run finds no user to tick. The `when` sits above
-- 0297's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
WITH ticked AS (
  UPDATE "public"."workspace_users" u
     SET "moderator" = true
    FROM "public"."workspaces" w, auth.users l
   WHERE w."id" = u."workspace_id" AND w."is_admin"
     AND l."id" = u."login_id" AND l."role" = 'admin'
     AND NOT u."moderator"
  RETURNING u."workspace_id", u."login_id")
INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
SELECT t."workspace_id", NULL, 'user.moderator',
       jsonb_build_object('login', t."login_id", 'moderator', true, 'by', 'migration 0298')
  FROM ticked t;
