-- Tailscale auth key + device name, so the tailnet can be activated from the
-- UI (/settings/network) instead of editing the VPS .env. Singleton per owner.
-- The auth key is sealed AES-256-GCM at rest (AAD = row id) like api_keys /
-- pdf_passwords; only `masked` (first 4 + last 4) is ever shown to the UI.
CREATE TABLE IF NOT EXISTS "tailscale_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  -- The Tailscale auth key, sealed AES-256-GCM (AAD = row id).
  "auth_key_enc" bytea NOT NULL,
  "key_version" integer NOT NULL DEFAULT 1,
  -- Device name to register on the tailnet (TS_HOSTNAME equivalent).
  "hostname" text NOT NULL DEFAULT 'mantle',
  -- Precomputed first-4 + last-4 of the key, for list/render without decrypting.
  "masked" text NOT NULL DEFAULT '••••',
  -- Bumped each time the tailnet is activated from the UI.
  "last_activated_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  -- One config per owner (singleton).
  CONSTRAINT "tailscale_config_owner_id_unique" UNIQUE ("owner_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tailscale_config_owner_idx" ON "tailscale_config" ("owner_id");
