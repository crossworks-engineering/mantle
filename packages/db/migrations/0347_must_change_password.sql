-- The box policy, part 1 (plan "Corporate sign-in", Phase 1; docs/policy.md):
-- the password rule's forced change, auth.users.must_change_password and
-- password_checked_min, and the model block's provider alert
-- (provider_alerts subject model_policy, below).
--
-- Set at a password sign-in only while the box policy sets a password rule
-- (MANTLE_POLICY_PASSWORD_MIN) and the password just taken fails it. While
-- it is set and the rule is in force, the login reaches nothing but the
-- change-password step (the request gate, server/web lib/auth
-- password-hold.ts). Any new password clears it (every password write goes
-- through the one rule, which the new one meets).
--
-- password_checked_min: the rule's minimum the login's password was last
-- checked against (at a sign-in, a password prompt or a new password; a
-- new password set while no rule is in force writes null, so it is checked
-- when a rule comes back).
-- Null: never under a rule. While a rule is set, a login whose password
-- was not checked under it (null, or a lower minimum: the rule went on or
-- up since) must sign in with its password once before anything else, so
-- the rule can check it.
--
-- A box with no password rule never reads either. It writes them only
-- with a new password and the first owner, the values they already hold
-- there (false and null): sign-in is exactly as before.
--
-- Grants come from the access matrix, never from here: the narrow login
-- gets no UPDATE on either column (both are written on the full route, at
-- sign-in and with a new password, as password_hash is).
--
-- Additive: two columns, one with a constant default (no table rewrite on
-- Postgres 11+), and one wider CHECK, no trigger, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0347_must_change_password.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
-- Both tables in one statement first, in one order, so no other session
-- holds one while waiting for the other.
LOCK TABLE "auth"."users", "public"."provider_alerts" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "auth"."users"
  ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "password_checked_min" integer;
--> statement-breakpoint
-- The box policy's model block (MANTLE_POLICY_MODEL_DENY,
-- MANTLE_POLICY_PROVIDER_ALLOW) opens a provider alert of its own when it
-- refuses a call: subject `model_policy` (@mantle/voice model-policy.ts).
-- Read by the admin's alert list; the extract circuit never reads it. A box
-- with no model rule never writes one.
ALTER TABLE "public"."provider_alerts" DROP CONSTRAINT IF EXISTS "provider_alerts_subject_check";
--> statement-breakpoint
ALTER TABLE "public"."provider_alerts"
  ADD CONSTRAINT "provider_alerts_subject_check"
  CHECK ("subject" IN ('embedding', 'extraction', 'model_policy'));
