-- auth.users — Mantle's identity table. Owned by Mantle (not Supabase) since
-- the lean-stack migration. Tables in public.* FK into here, so this must
-- exist BEFORE Drizzle migrations 0000/0001/0009 run.
--
-- Lives in /docker-entrypoint-initdb.d/ — runs once at first cluster init.
-- Re-running compose against the same volume is a no-op.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id            uuid        PRIMARY KEY,
  email         text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Multi-admin logins (0111): the anchor row (is_owner, unique) is the account
  -- all brain content is keyed to; other rows are co-admin identities for the
  -- audit trail. read_only blocks mutations for that login.
  is_owner      boolean     NOT NULL DEFAULT false,
  read_only     boolean     NOT NULL DEFAULT false,
  display_name  text,
  last_login_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS users_single_owner_idx ON auth.users (is_owner) WHERE is_owner;
