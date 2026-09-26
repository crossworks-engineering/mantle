-- Member chat (member logins, plan section 5): a member login's thread with a
-- team-level agent. One thread per LOGIN, kept in team_messages (never in
-- assistant_messages: every insert there feeds the owner's summarizer). Rows
-- from the team portal keep login_id null; a member's rows carry their login,
-- and the thread is read by (owner, login). The login's rows go with it.
ALTER TABLE "team_messages" ADD COLUMN IF NOT EXISTS "login_id" uuid
  REFERENCES "auth"."users"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_messages_login_thread_idx"
  ON "team_messages" ("owner_id", "login_id", "created_at")
  WHERE "login_id" IS NOT NULL;
