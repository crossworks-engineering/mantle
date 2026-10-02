-- "Team apps may use" becomes "External access" (decided 2026-10-02; docs/
-- member-logins.md, "External access: outside tools in shared apps").
--
-- The switch an admin sets on ONE outside tool (mcp or http) now reaches
-- everyone an app is shared with, not team members only: members (team and
-- public apps), clients (client apps) and contacts on a contact-share link.
-- Same data, wider meaning, so the column takes the new name. Nothing in it
-- changes: when and by whom the read-only confirmation was given, and the
-- signature of the handler the admin looked at.
--
-- No data moves: nobody had switched it on yet (Jason, 2026-10-02). The
-- rename is still needed because 0215 has shipped, and a brain that ran it
-- has the old column. Idempotent: renames only while the old column is there
-- and the new one is not.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tools' AND column_name = 'team_apps'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tools' AND column_name = 'external_access'
  ) THEN
    ALTER TABLE "public"."tools" RENAME COLUMN "team_apps" TO "external_access";
  END IF;
END $$;
ALTER TABLE "public"."tools" ADD COLUMN IF NOT EXISTS "external_access" jsonb;

-- A contact on a contact-share link may now call such a tool from the shared
-- app (the /s tool broker). The share's trail records each call as 'tool'.
ALTER TABLE "public"."share_access_log" DROP CONSTRAINT IF EXISTS "share_access_log_kind_ck";
ALTER TABLE "public"."share_access_log" ADD CONSTRAINT "share_access_log_kind_ck"
  CHECK ("kind" IN ('open', 'asset', 'query', 'write', 'tool', 'refused', 'code_failed'));
