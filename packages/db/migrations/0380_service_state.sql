-- The state of an optional service (Sync service plan M2, page f11288e3,
-- decision 7). The Sync sidecar (server/sync) keeps no disk: each linked
-- account's settings and password, each feed, and each sync cursor live
-- here, one row per (service, key), the value sealed with the master key
-- (AAD `service:key`) by the brain before it is written.
--
-- Read and written only by the brain's sidecar routes (/api/sidecar/*, the
-- service's own token), on the system pool, outside every scope: the
-- runtime role holds no right on it (access-matrix.ts, as sso_setup).
-- Additive, no rewrite, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0380_service_state.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."service_state" (
  "service" text NOT NULL,
  "key" text NOT NULL,
  "value_enc" bytea NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("service", "key"),
  CONSTRAINT "service_state_service_ck" CHECK ("service" ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  CONSTRAINT "service_state_key_ck" CHECK ("key" ~ '^[a-z0-9][a-z0-9:._-]{0,199}$'),
  CONSTRAINT "service_state_value_ck" CHECK (octet_length("value_enc") <= 262144)
);
