-- UI-settable Azure AD app registration for Microsoft Graph OAuth, so a brain
-- can be configured from /settings/microsoft instead of editing .env + restart.
-- Singleton per owner (like tailscale_config / embedding_config). The client
-- secret is sealed at rest (AES-256-GCM, AAD = owner_id); client id / tenant /
-- redirect URI are not secret. Loader falls back to MS_* env when absent.
CREATE TABLE "microsoft_config" (
	"owner_id" uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
	"client_id" text NOT NULL,
	"client_secret_enc" bytea NOT NULL,
	"key_version" integer NOT NULL DEFAULT 1,
	"secret_masked" text NOT NULL DEFAULT '••••',
	"tenant" text NOT NULL DEFAULT 'common',
	"redirect_uri" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
