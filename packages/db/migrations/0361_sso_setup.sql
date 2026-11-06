-- The setup screen of company sign-in and SCIM (docs/oidc-sign-in.md): one
-- row holding what a client's Microsoft admin enters or makes while
-- MANTLE_OIDC_MODE=setup. secret_enc is the provider's client secret, sealed
-- (AAD sso_setup:secret), never shown. scim_token_hash is the sha256 of the
-- SCIM token, which is shown once. Each with who set it and when. The mode,
-- the issuer and the client id stay in the box .env: that is the lock.
--
-- Read and written only at the full-route spot oidc-link
-- (server/web lib/oidc/store.ts): the narrow login and the workspace role
-- hold no right on it. Grants come from the access matrix
-- (applyViewerGrants), never from here.
--
-- Additive, no trigger, no LLM work. Re-runnable. With the mode off, nothing
-- reads the row.
-- Revert: packages/db/rollback/0361_sso_setup.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."sso_setup" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "secret_enc" bytea,
  "secret_set_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "secret_set_at" timestamp with time zone,
  "scim_token_hash" text,
  "scim_set_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "scim_set_at" timestamp with time zone,
  CONSTRAINT "sso_setup_one_row_ck" CHECK ("id")
);
