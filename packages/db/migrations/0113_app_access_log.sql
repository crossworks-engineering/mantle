-- Audit trail for the external app-share surface (/s/<token>/*).
--
-- One row per visitor action against a shared mini-app: team-token auth,
-- brokered tool call, brokered db statement. contact_id NULL = anonymous
-- public-mode visitor; SET NULL on contact deletion so history outlives the
-- contact record. Owner-side broker calls are not logged here.
--
-- (The share's public|team mode itself needs no migration — it lives in the
-- existing shares.settings jsonb as settings.mode, absent = public.)

CREATE TABLE IF NOT EXISTS "app_access_log" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"    uuid NOT NULL,
  "app_node_id" uuid NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
  "share_id"    uuid,
  "contact_id"  uuid REFERENCES "nodes"("id") ON DELETE SET NULL,
  "kind"        text NOT NULL,
  "detail"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_access_log_app_idx" ON "app_access_log" ("app_node_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_access_log_owner_idx" ON "app_access_log" ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_access_log_contact_idx" ON "app_access_log" ("contact_id");
