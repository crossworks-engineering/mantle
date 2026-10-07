-- Inbound API keys (plan page 1e62e204, 2026-10-07).
--
-- access_keys: a named key an admin makes. It acts as ONE login (admin,
-- member or client) and can only narrow that login's rights:
--   access       'read' or 'read_write'
--   areas        NULL = all areas, else a list (pages, tables, ...)
--   risky_tools  for an admin key on /api/mcp: risky tools allowed by name
-- The secret is shown once. Only its SHA-256 is kept; `key_prefix` is the
-- public part of the secret, the lookup key and what the UI shows.
-- `login_role` is the login's role at mint: a role change ends the key, as
-- does a disable. An admin's or member's key is its own credential: a plain
-- sign-out leaves it; a password change, "sign out everywhere" and an
-- admin's End sessions revoke it (the code does, endLoginSessions).
--
-- `session_epoch` is set for a CLIENT key only (M2 audit N5): a client has
-- no password to re-type, so its key is bound to the session it was made
-- in and ends when the client signs out. Admin and member keys hold NULL.
--
-- The unique index on key_hash is kept on purpose: it does no lookup work
-- (lookups go by key_prefix), it guarantees no two rows hold one secret.
--
-- Text with CHECK constraints, no enum. Plain DDL, no trigger, no job.
-- Idempotent.
CREATE TABLE IF NOT EXISTS "public"."access_keys" (
  "id"            uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "name"          text NOT NULL,
  "login_id"      uuid NOT NULL,
  "login_role"    text NOT NULL,
  "key_prefix"    text NOT NULL,
  "key_hash"      text NOT NULL,
  "session_epoch" integer,
  "access"        text NOT NULL,
  "areas"         text[],
  "risky_tools"   text[] NOT NULL DEFAULT '{}'::text[],
  "expires_at"    timestamptz,
  "created_by"    uuid,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "last_used_at"  timestamptz,
  "last_used_ip"  text,
  "revoked_at"    timestamptz,
  "revoked_by"    uuid,
  CONSTRAINT "access_keys_login_fk"
    FOREIGN KEY ("login_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  CONSTRAINT "access_keys_created_by_fk"
    FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  CONSTRAINT "access_keys_revoked_by_fk"
    FOREIGN KEY ("revoked_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  CONSTRAINT "access_keys_access_ck" CHECK ("access" IN ('read', 'read_write')),
  CONSTRAINT "access_keys_role_ck" CHECK ("login_role" IN ('admin', 'member', 'client')),
  CONSTRAINT "access_keys_name_ck" CHECK (length("name") BETWEEN 1 AND 100),
  CONSTRAINT "access_keys_prefix_ck" CHECK ("key_prefix" ~ '^[A-Za-z0-9]{8}$'),
  CONSTRAINT "access_keys_hash_ck" CHECK ("key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "access_keys_risky_ck"
    CHECK ("login_role" = 'admin' OR cardinality("risky_tools") = 0),
  CONSTRAINT "access_keys_areas_ck"
    CHECK ("areas" IS NULL OR cardinality("areas") > 0),
  CONSTRAINT "access_keys_client_epoch_ck"
    CHECK (("login_role" = 'client') = ("session_epoch" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "access_keys_prefix_uq"
  ON "public"."access_keys" ("key_prefix");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "access_keys_hash_uq"
  ON "public"."access_keys" ("key_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_keys_login_idx"
  ON "public"."access_keys" ("login_id");
