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
  -- audit trail. No per-user access scope here (team tiers are a separate surface).
  is_owner      boolean     NOT NULL DEFAULT false,
  display_name  text,
  last_login_at timestamptz,
  -- Member logins (0162), client logins (0187): admin, member or client; the
  -- anchor is always admin. The contact FK is added by migration 0162 (nodes
  -- does not exist yet at cluster init).
  role          text        NOT NULL DEFAULT 'admin',
  contact_id    uuid,
  disabled_at   timestamptz,
  -- Signed into every session (0181); bumping it ends them all.
  session_epoch integer     NOT NULL DEFAULT 0,
  -- The same CHECK 0187 leaves (0162 skips it when it exists, 0187 drops and
  -- re-adds it). Kept in step with the migrations so this table has the
  -- dumped shape; db-restore.sh no longer relies on it (pristine database).
  CONSTRAINT users_role_ck
    CHECK (role IN ('admin', 'member', 'client') AND (NOT is_owner OR role = 'admin'))
);

CREATE UNIQUE INDEX IF NOT EXISTS users_single_owner_idx ON auth.users (is_owner) WHERE is_owner;
