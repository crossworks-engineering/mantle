-- Team apps Phase 3 (plan page b6dd688e, sections A.2 to A.5): members build
-- mini apps in their own personal space, like Pages.
--
-- `apps.author_login_id`: the login that built the app; null for an app an
-- admin built (every app before this release).
--
-- `apps.author_level`: the AUTHOR CEILING (A.4). An app runs its tools at
-- most at this level, for every runner, an admin's run included: a member
-- builds at 'team', so an admin who opens a member's app never fires an
-- admin tool through it. An admin raises it to 'admin' only when accepting
-- the app, after seeing its declared tools. Every existing app is 'admin'.
--
-- `node_snapshots.actor_login_id`: the login a history row names when the
-- actor is a member (the author's own snapshot, publish or restore).
--
-- Rollback: the previous release never reads these columns. A member's app
-- stays in their space (no admin route lists it), so nothing runs it there.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

ALTER TABLE "public"."apps"
  ADD COLUMN IF NOT EXISTS "author_login_id" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."apps"
  ADD COLUMN IF NOT EXISTS "author_level" text NOT NULL DEFAULT 'admin';
--> statement-breakpoint
ALTER TABLE "public"."apps" DROP CONSTRAINT IF EXISTS "apps_author_level_ck";
--> statement-breakpoint
ALTER TABLE "public"."apps" ADD CONSTRAINT "apps_author_level_ck"
  CHECK ("author_level" IN ('admin', 'team'));
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots"
  ADD COLUMN IF NOT EXISTS "actor_login_id" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL;
