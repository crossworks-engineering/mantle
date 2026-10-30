-- The box policy, part 1 (plan "Corporate sign-in", Phase 1; docs/policy.md):
-- the password rule's forced change, auth.users.must_change_password, and
-- the model block's provider alert (provider_alerts subject model_policy,
-- below).
--
-- Set at a password sign-in only while the box policy sets a password rule
-- (MANTLE_POLICY_PASSWORD_MIN) and the password just taken fails it. While
-- it is set and the rule is in force, the login reaches nothing but the
-- change-password step (the request gate, server/web lib/auth
-- password-hold.ts). Any new password clears it (every password write goes
-- through the one rule, which the new one meets).
--
-- A box with no password rule never sets it and never reads it: every row
-- keeps the default, false, and sign-in is exactly as before.
--
-- Grants come from the access matrix, never from here: the narrow login
-- gets no UPDATE on the column (the flag is written on the full route, at
-- sign-in and with a new password, as password_hash is).
--
-- Additive: one column with a constant default (no table rewrite on
-- Postgres 11+) and one wider CHECK, no trigger, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0347_must_change_password.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "auth"."users"
  ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL;
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
