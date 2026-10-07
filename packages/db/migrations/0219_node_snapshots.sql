-- Snapshots and versions of an app (apps first-class plan, Phase 2;
-- docs/app-authoring-guide.md, "History: versions and snapshots").
--
-- One numbered timeline per node. A publish appends a VERSION (the code that
-- went live). A SNAPSHOT (taken by the owner, or automatically before a
-- restore or a schema change) also keeps a copy of the app's SQLite database,
-- as a file under APP_DB_DIR/_snapshots (db_path is relative to APP_DB_DIR).
-- Append-only: a restore adds rows, never rewrites them. Admin only: no
-- viewer grant (packages/db/src/access-matrix.ts).
CREATE TABLE IF NOT EXISTS "public"."node_snapshots" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"       uuid NOT NULL,
  "node_id"        uuid NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "node_kind"      text NOT NULL,
  "seq"            integer NOT NULL,
  "trigger"        text NOT NULL,
  "note"           text,
  "actor"          text NOT NULL,
  "code"           jsonb,
  "source_hash"    text,
  "db_path"        text,
  "db_bytes"       bigint,
  "schema_version" integer,
  "restored_from"  integer,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "node_snapshots_kind_ck" CHECK ("node_kind" IN ('app', 'table')),
  CONSTRAINT "node_snapshots_trigger_ck" CHECK ("trigger" IN
    ('publish', 'manual', 'pre_restore', 'pre_schema', 'pre_delete', 'pre_import', 'nightly'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "node_snapshots_node_seq_uq"
  ON "public"."node_snapshots" ("node_id", "seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "node_snapshots_owner_idx" ON "public"."node_snapshots" ("owner_id");
--> statement-breakpoint
-- The version a code-only restore came from, carried by the next publish
-- into its version row (restored_from), then cleared.
ALTER TABLE "public"."apps" ADD COLUMN IF NOT EXISTS "restored_from_seq" integer;
--> statement-breakpoint
-- v1 for every app already published: its live code as of this release. Pure
-- SQL, no model call. An app never published starts its line at its first
-- publish.
INSERT INTO "public"."node_snapshots"
  ("owner_id", "node_id", "node_kind", "seq", "trigger", "note", "actor", "code")
SELECT n."owner_id", a."node_id", 'app', 1, 'publish',
       'the live app when version history began', 'system',
       jsonb_build_object(
         'source', a."source",
         'draft', NULL,
         'manifest', a."manifest",
         'publishedBuild', a."published_build")
  FROM "public"."apps" a
  JOIN "public"."nodes" n ON n."id" = a."node_id"
 WHERE a."published_build" IS NOT NULL
ON CONFLICT ("node_id", "seq") DO NOTHING;
