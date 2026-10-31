-- Company sign-in for a client that holds no browser session (corporate plan
-- Phase 4 milestone 2, docs/oidc-sign-in.md "Handing a sign-in to a client").
-- One empty table; nothing reads it while MANTLE_OIDC_MODE is off (the
-- default), so a box that sets nothing behaves exactly as before.
--
-- oidc_handoff_codes: a one-time code the callback hands to the client that
-- started a flow. The web app, the desktop app and the phone all hold a
-- bearer, and the provider's sign-in runs in a browser, so the callback cannot
-- give them a cookie: it sends a code to the client's redirect target, and the
-- client trades the code and its PKCE verifier for what the flow was for (a
-- bearer, a link, a fresh sign-in at key creation or MCP consent).
--
-- Only the code's sha256 is kept. A code lasts 2 minutes and works once:
-- `used_at` is set by the one statement that spends it, before the verifier
-- is compared, so a wrong guess burns the code. `challenge` is the client's
-- S256 challenge; null only for the MCP consent page, a page of this brain
-- whose code the signed-in login itself spends. `identity` is the provider
-- account of a link, made only when the client spends the code. A code goes
-- with its login (ON DELETE CASCADE).
--
-- Written only at the full-route spot oidc-link (server/web
-- lib/oidc/store.ts): a code is a way in, so neither the narrow login nor the
-- workspace role has any right on it. Grants come from the access matrix
-- (applyViewerGrants), never from here.
--
-- Additive, idempotent, no trigger, no LLM work.
-- Revert: packages/db/rollback/0350_oidc_handoff_codes.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."oidc_handoff_codes" (
  "code_hash" text PRIMARY KEY NOT NULL,
  "purpose" text NOT NULL,
  "login_id" uuid NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "epoch" integer NOT NULL,
  "challenge" text,
  "identity" jsonb,
  "held" boolean DEFAULT false NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "oidc_handoff_codes_purpose_ck" CHECK ("purpose" IN ('signin', 'link', 'fresh'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oidc_handoff_codes_expires_idx"
  ON "public"."oidc_handoff_codes" ("expires_at");
