-- CLI sandboxes: persistent isolated terminal environments managed by the
-- sandboxd supervisor (compose profile `sandboxes`). Infrastructure objects,
-- not nodes — nothing here enters retrieval. Per-command history lives in
-- trace steps; the durable work product is the per-sandbox /files host dir,
-- which outlives both the container and this row. See
-- packages/db/src/schema/sandboxes.ts.

CREATE TYPE "public"."sandbox_status" AS ENUM('running', 'stopped');
CREATE TYPE "public"."sandbox_network" AS ENUM('full', 'none');

CREATE TABLE IF NOT EXISTS "sandboxes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "image" text NOT NULL,
  "status" "sandbox_status" DEFAULT 'running' NOT NULL,
  "network" "sandbox_network" DEFAULT 'full' NOT NULL,
  "container_id" text,
  "last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "sandboxes_owner_name_uq" ON "sandboxes" ("owner_id", "name");
CREATE INDEX IF NOT EXISTS "sandboxes_owner_idx" ON "sandboxes" ("owner_id");
