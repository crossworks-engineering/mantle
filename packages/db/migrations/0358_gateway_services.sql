-- The service gateway (docs/gateway.md; Data sources plan, phase 1a): the
-- one internal door from the brain to the services of its box. A service
-- sits on the internal network mantle_services, publishes no port and has
-- no Caddy route; the gateway (server/gateway) is on that network and on
-- the default one, and routes `/svc/<slug>/<path>` only to a service listed
-- here. A model never names a host: an unknown or disabled slug, a method
-- or a path the row does not allow is refused by the gateway.
--
-- gateway_services, one row per service: its slug (the URL's), a name,
-- the upstream `host:port` on mantle_services (one DNS label: the
-- service's container name), the path prefixes and the
-- methods it allows, the reads-only mark (what the owner says of the
-- service: shown, never relied on; the service's own login decides what
-- it may change), the switch, a note, the login that last set it. Written
-- by an Admin user (the connectors area) at the full-route spot
-- tool-config (where calls go, as a tool group's integration), read by the
-- gateway and the brain on the system pool.
--
-- gateway_calls, one row per call the gateway answered or refused: the
-- slug asked for (also an unknown one), method, path (no query string),
-- status, bytes each way, duration, the caller the brain named (an agent,
-- a login, a connector) and its login, and the refusal's fixed code.
-- Written by the gateway only, on the system pool, outside every scope; the
-- gateway removes rows past 90 days itself. No reply body is kept.
--
-- No grant to the workspace role (access matrix: none): only the system
-- pool reads either table. Grants come from the access matrix
-- (applyViewerGrants), never from here.
-- Additive, no rewrite, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0358_gateway_services.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gateway_services" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "upstream" text NOT NULL,
  "path_prefixes" text[] DEFAULT '{/}'::text[] NOT NULL,
  "methods" text[] DEFAULT '{GET}'::text[] NOT NULL,
  "reads_only" boolean DEFAULT true NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "note" text,
  "created_by" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "gateway_services_slug_ck" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  CONSTRAINT "gateway_services_name_ck" CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "gateway_services_upstream_ck" CHECK (
    "upstream" ~ '^[a-z0-9]([a-z0-9_-]{0,61}[a-z0-9])?:[0-9]{1,5}$'),
  CONSTRAINT "gateway_services_prefixes_ck" CHECK (cardinality("path_prefixes") BETWEEN 1 AND 20),
  CONSTRAINT "gateway_services_methods_n_ck" CHECK (cardinality("methods") BETWEEN 1 AND 7),
  CONSTRAINT "gateway_services_methods_ck" CHECK (
    "methods" <@ ARRAY['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']::text[]),
  CONSTRAINT "gateway_services_note_ck" CHECK ("note" IS NULL OR char_length("note") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gateway_services_slug_uq" ON "public"."gateway_services" ("slug");
--> statement-breakpoint
-- The enable class on the narrow role (0324, 0325): a service's switch
-- only goes off there, on an update or an insert (the narrow role writes no
-- row of this table anyway; the rule keeps the catalog's one shape).
DROP TRIGGER IF EXISTS "mantle_narrow_one_way_trg" ON "public"."gateway_services";
--> statement-breakpoint
CREATE TRIGGER "mantle_narrow_one_way_trg" BEFORE INSERT OR UPDATE ON "public"."gateway_services"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_narrow_one_way"('off:enabled');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gateway_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "service_slug" text NOT NULL,
  "method" text NOT NULL,
  "path" text NOT NULL,
  "status" integer NOT NULL,
  "request_bytes" bigint DEFAULT 0 NOT NULL,
  "response_bytes" bigint DEFAULT 0 NOT NULL,
  "duration_ms" integer NOT NULL,
  "caller" text,
  "login_id" uuid,
  "refusal" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "gateway_calls_slug_ck" CHECK (char_length("service_slug") <= 64),
  CONSTRAINT "gateway_calls_method_ck" CHECK (char_length("method") <= 16),
  CONSTRAINT "gateway_calls_path_ck" CHECK (char_length("path") <= 512),
  CONSTRAINT "gateway_calls_caller_ck" CHECK ("caller" IS NULL OR char_length("caller") <= 200),
  CONSTRAINT "gateway_calls_refusal_ck" CHECK ("refusal" IS NULL OR char_length("refusal") <= 64)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gateway_calls_created_idx" ON "public"."gateway_calls" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gateway_calls_slug_created_idx"
  ON "public"."gateway_calls" ("service_slug", "created_at" DESC);
