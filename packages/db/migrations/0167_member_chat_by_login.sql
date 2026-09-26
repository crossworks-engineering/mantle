-- Users are the team (Jason, 2026-09-26): a member login IS the team member.
-- It needs no contact. A member's chat rows carry the login and may carry no
-- contact; team portal rows keep their contact and no login. Every row names
-- one of the two.
ALTER TABLE "team_messages" ALTER COLUMN "contact_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_messages" ADD CONSTRAINT "team_messages_who_ck"
  CHECK ("contact_id" IS NOT NULL OR "login_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "team_messages" VALIDATE CONSTRAINT "team_messages_who_ck";
