-- Credential vault v2, part 1: the one vault, api_keys, holds more kinds of
-- secret than an API token. A box that adds nothing behaves exactly as
-- before: every row today reads as a token with no target, no fields, no
-- approval and no tags.
--
-- Columns:
--   kind            token (every row today), password, ssh_key, login (a user
--                   and a password). Only a token is opened by the read paths
--                   in this release (@mantle/api-keys): a secret of another
--                   kind waits for the use gateway (part 2). Its key_enc is
--                   sealed with `<id>:<kind>`, a token's with the row id
--                   (as before), so no token read opens one.
--   name            what agents say. Generated from service and label, so it
--                   never drifts from them: the service alone when the label
--                   is 'default', else service/label. A service is a slug (no
--                   '/', every writer takes one), so one name is one row;
--                   unique per owner.
--   target          where the secret may be used: hosts or web origins. Empty
--                   = a provider key, as today. Read by the use gateway
--                   (part 2); only written here.
--   fields_enc      the sealed JSON of a many-field kind (user, passphrase,
--                   sudo password, port), AAD `<id>:fields`. Null for a token.
--   host_key        SSH only: the pinned server key (part 3). Empty here.
--   needs_approval  each use waits for the owner (part 2). The write gateway
--                   sets it on for password, ssh_key and login.
--   tags            the groups an agent's grant names (part 2).
--   via_tailnet     the executor dials through the tailnet (part 3).
--   use_count       uses, for the Keys screen (counted from part 2).
--
-- Grants come from the access matrix (applyViewerGrants), never from here:
-- api_keys stays closed to every workspace role, and the narrow login gets
-- no UPDATE on a new column (a change of kind, target, approval, tags,
-- tailnet or fields runs at the full-route spot model-route).
--
-- Additive: no value is rewritten, no trigger, no LLM work. The generated
-- column rewrites the table once (a small table). Re-runnable.
-- Revert: packages/db/rollback/0346_vault_kinds.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "public"."api_keys"
  ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'token' NOT NULL,
  ADD COLUMN IF NOT EXISTS "name" text GENERATED ALWAYS AS (
    CASE WHEN "label" = 'default' THEN "service" ELSE "service" || '/' || "label" END
  ) STORED,
  ADD COLUMN IF NOT EXISTS "target" text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN IF NOT EXISTS "fields_enc" bytea,
  ADD COLUMN IF NOT EXISTS "host_key" text,
  ADD COLUMN IF NOT EXISTS "needs_approval" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "tags" text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN IF NOT EXISTS "via_tailnet" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "use_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_kind_chk";
--> statement-breakpoint
ALTER TABLE "public"."api_keys"
  ADD CONSTRAINT "api_keys_kind_chk"
  CHECK ("kind" IN ('token', 'password', 'ssh_key', 'login'));
--> statement-breakpoint
-- A token keeps its one value in key_enc; only a many-field kind has fields.
ALTER TABLE "public"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_fields_kind_chk";
--> statement-breakpoint
ALTER TABLE "public"."api_keys"
  ADD CONSTRAINT "api_keys_fields_kind_chk"
  CHECK ("fields_enc" IS NULL OR "kind" <> 'token');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_user_name_uq"
  ON "public"."api_keys" ("user_id", "name");
