-- Microsoft Graph foundation (M0): one row per connected Microsoft identity,
-- delegated OAuth. The Azure app registration is shared per-deployment (env);
-- the per-user OAuth tokens are sealed here (AES-256-GCM, AAD = row id) exactly
-- like api_keys. M1–M3 add per-surface item tables; the delta cursors live in
-- `sync_state`. See docs/microsoft-graph-ingest.md.
CREATE TABLE "ms_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	"upn" text NOT NULL,
	"display_name" text,
	"tenant_id" text,
	"access_token_enc" bytea,
	"refresh_token_enc" bytea,
	"token_expires_at" timestamp with time zone,
	"scopes" text[] NOT NULL DEFAULT '{}'::text[],
	"branch_path" text NOT NULL,
	"surfaces" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"sync_state" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"last_sync_at" timestamp with time zone,
	"last_sync_error" text,
	"enabled" boolean NOT NULL DEFAULT true,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "ms_accounts_user_idx" ON "ms_accounts" ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ms_accounts_user_upn_uq" ON "ms_accounts" ("user_id","upn");
