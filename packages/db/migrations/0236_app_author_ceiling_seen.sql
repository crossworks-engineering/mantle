-- Team apps Phase 3 (M3 re-audit, jackdaw low 1): `apps.author_ceiling_seen`
-- is true once an app has ever run at the author ceiling ('team'): a
-- member built it, or its code came from a copy, an import or a member-era
-- restore. It never goes back to false, so an admin who trusted an app's
-- tools (author_level back to 'admin') still sees the "Trust its tools"
-- switch and can undo the trust. A trigger sets it on every write that
-- makes author_level 'team', so no code path can forget it.
--
-- Rollback: the previous release never reads the column; the trigger only
-- sets the column, never anything else.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

ALTER TABLE "public"."apps"
  ADD COLUMN IF NOT EXISTS "author_ceiling_seen" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "public"."apps" SET "author_ceiling_seen" = true
  WHERE "author_level" = 'team' OR "author_login_id" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."apps_author_ceiling_seen"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."author_level" = 'team' THEN
    NEW."author_ceiling_seen" := true;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "apps_author_ceiling_seen" ON "public"."apps";
--> statement-breakpoint
CREATE TRIGGER "apps_author_ceiling_seen"
  BEFORE INSERT OR UPDATE OF "author_level" ON "public"."apps"
  FOR EACH ROW EXECUTE FUNCTION "public"."apps_author_ceiling_seen"();
