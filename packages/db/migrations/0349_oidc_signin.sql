-- Company sign-in (OIDC, corporate plan Phase 4 milestone 1,
-- docs/oidc-sign-in.md). Two empty tables; nothing reads them while
-- MANTLE_OIDC_MODE is off (the default), so a box that sets nothing behaves
-- exactly as before.
--
-- oidc_signin_links: which company account (the provider's issuer plus its
-- subject) signs in as which login. Unique on issuer plus subject (one
-- account, one login) and on login plus issuer (one account per login per
-- provider). Never keyed on an email. tid and oid are kept beside the
-- subject (claims some providers tie it to); nothing matches on them. A link
-- goes with its login (ON DELETE CASCADE).
--
-- oidc_login_state: per login, `outside` (an admin marked an outside person,
-- who keeps a password in required mode) and `offer_dismissed_until` (the
-- login hid the "link now" offer). A login with no row is not outside and
-- has dismissed nothing.
--
-- oidc_mode_state: one row, the mode the last boot with company sign-in on
-- applied, so the boot ends the old sessions only on a real switch into
-- required (not at every restart). Never read or written while off.
--
-- Written only at the full-route spot oidc-link (server/web lib/oidc/store.ts):
-- a link is a way in, so the narrow login only reads the three tables
-- (access-matrix.ts). A link is removed only by an unlink (the login's own,
-- or an admin's), never as a side effect of a session end. The workspace role reads neither. Grants come from the
-- access matrix (applyViewerGrants), never from here.
--
-- Additive, idempotent, no trigger, no LLM work.
-- Revert: packages/db/rollback/0349_oidc_signin.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."oidc_signin_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "login_id" uuid NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "issuer" text NOT NULL,
  "subject" text NOT NULL,
  "tid" text,
  "oid" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  CONSTRAINT "oidc_signin_links_issuer_ck" CHECK (length("issuer") BETWEEN 1 AND 512),
  CONSTRAINT "oidc_signin_links_subject_ck" CHECK (length("subject") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oidc_signin_links_issuer_subject_key"
  ON "public"."oidc_signin_links" ("issuer", "subject");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oidc_signin_links_login_issuer_key"
  ON "public"."oidc_signin_links" ("login_id", "issuer");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oidc_signin_links_login_idx"
  ON "public"."oidc_signin_links" ("login_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."oidc_mode_state" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "mode" text NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "oidc_mode_state_one_row_ck" CHECK ("id"),
  CONSTRAINT "oidc_mode_state_mode_ck" CHECK ("mode" IN ('optional', 'required'))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."oidc_login_state" (
  "login_id" uuid PRIMARY KEY NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "outside" boolean DEFAULT false NOT NULL,
  "offer_dismissed_until" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
