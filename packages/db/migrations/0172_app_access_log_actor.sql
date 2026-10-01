-- Member logins Phase 4b: members run team-level apps from their own shell,
-- signed in as a LOGIN, not a team-portal contact. The app access log (who
-- used a shared app's tools and database) was keyed on contact_id only; it
-- now also names the login. SET NULL on login delete, like contact_id: the
-- record that something happened outlives the login. Nullable, no backfill:
-- every earlier row came from a share link (a contact or an anonymous visitor).
ALTER TABLE "app_access_log" ADD COLUMN IF NOT EXISTS "actor_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_access_log_actor_fk') THEN
    ALTER TABLE "app_access_log" ADD CONSTRAINT "app_access_log_actor_fk"
      FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;
  END IF;
END
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_access_log_actor_idx" ON "app_access_log" ("actor_id");
