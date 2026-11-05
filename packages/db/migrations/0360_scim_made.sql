-- SCIM: which logins the provider made (docs/scim.md, "Signing in the
-- first time"). scim_users.made_by_scim is true for a login the provider
-- created through POST /scim/v2/Users, false for a login made by hand that
-- the provider later matched by its email. Only a login the provider made
-- may be linked to a company account by the provider's object id at its
-- first company sign-in (MANTLE_SCIM_AUTO_LINK): a login matched by email
-- never is, so no link ever rests on an email.
--
-- Written with the login's row at the full-route spot login-credential
-- (server/web lib/scim/store.ts createScimLogin); no other writer.
-- Additive, no rewrite, no LLM work. Re-runnable. Every existing row reads
-- false (none was made with the mark: no auto-link for them).
-- Revert: packages/db/rollback/0360_scim_made.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."scim_users" ADD COLUMN IF NOT EXISTS "made_by_scim" boolean DEFAULT false NOT NULL;
