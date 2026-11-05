-- SCIM user provisioning (docs/scim.md; corporate plan Phase 5, section
-- 10.1): a company's identity provider tells the box who may have access,
-- so a person it blocks loses Mantle access the same day.
--
-- scim_users, one row per login the provider manages: the login, and the
-- provider's own id for the person (externalId), kept as the provider sent
-- it. A row is made when the provider creates the login, or the first time
-- it writes to a login it found by its userName (the one match on a name,
-- allowed because the box operator gave the provider the token; plan
-- section 9.3). After that the provider names the login by its id. Nothing
-- signs in on this row: it is no way in, and a disable or a delete by the
-- provider runs the users area's own disable (server/web lib/scim).
--
-- Written at the full-route spot login-credential only (server/web
-- lib/scim/store.ts), read by the narrow role (the users area's report).
-- No grant to the workspace role (access matrix: none). Grants come from the
-- access matrix (applyViewerGrants), never from here.
-- Additive, no rewrite, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0359_scim_users.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."scim_users" (
  "login_id" uuid PRIMARY KEY NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "external_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scim_users_external_id_ck" CHECK (
    "external_id" IS NULL OR char_length("external_id") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scim_users_external_id_key"
  ON "public"."scim_users" ("external_id") WHERE "external_id" IS NOT NULL;
