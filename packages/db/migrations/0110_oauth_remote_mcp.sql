-- OAuth 2.1 authorization-server state for the remote MCP connector.
-- Mantle becomes the AS for its own /api/mcp resource: a claude.ai custom
-- connector registers (DCR), the owner signs in + consents, and the client
-- exchanges a PKCE code for an access token. See packages/db/src/schema/oauth.ts
-- and apps/web/lib/mcp-oauth.ts.
--
-- Secrets at rest: auth codes + access/refresh tokens are stored ONLY as their
-- SHA-256 hash (same as inbound peer tokens). Clients are public (PKCE, no
-- secret). owner_id FKs into auth.users (hand-managed schema), cascade on delete.

CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_name" text,
	"redirect_uris" text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "oauth_auth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL UNIQUE,
	"client_id" uuid NOT NULL REFERENCES "oauth_clients"(id) ON DELETE CASCADE,
	"owner_id" uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL DEFAULT 'S256',
	"redirect_uri" text NOT NULL,
	"scope" text NOT NULL DEFAULT '',
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "oauth_auth_codes_client_idx" ON "oauth_auth_codes" ("client_id");
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"refresh_token_hash" text UNIQUE,
	"owner_id" uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	"client_id" uuid NOT NULL REFERENCES "oauth_clients"(id) ON DELETE CASCADE,
	"scope" text NOT NULL DEFAULT '',
	"expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_owner_idx" ON "oauth_access_tokens" ("owner_id");
--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_client_idx" ON "oauth_access_tokens" ("client_id");
