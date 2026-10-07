-- Apps audit 2026-10-02, lows. Additive.
--
-- 1. An app's error rows (app_errors, the Activity tab, the reaper's per-app
--    cap in packages/content/src/app-access-log.ts) were read through the
--    app's whole access trail: a partial index on the error rows only.
CREATE INDEX IF NOT EXISTS "app_access_log_error_idx"
  ON "public"."app_access_log" ("app_node_id", "created_at" DESC)
  WHERE "kind" = 'error';
--> statement-breakpoint
-- 2. The History list read every row's code JSON (file count, source size,
--    whether a draft was kept) on every read; they are kept on the row now
--    (packages/content/src/node-snapshot-rows.ts), and filled in here for the
--    rows that exist.
ALTER TABLE "public"."node_snapshots" ADD COLUMN IF NOT EXISTS "file_count" integer;
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" ADD COLUMN IF NOT EXISTS "source_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" ADD COLUMN IF NOT EXISTS "has_draft" boolean;
--> statement-breakpoint
UPDATE "public"."node_snapshots" SET
  "file_count" = coalesce((select count(*) from jsonb_object_keys(coalesce("code"->'source'->'files', '{}'::jsonb))), 0),
  "source_bytes" = coalesce((select sum(octet_length(value)) from jsonb_each_text(coalesce("code"->'source'->'files', '{}'::jsonb))), 0),
  "has_draft" = coalesce(jsonb_typeof("code"->'draft') = 'object', false)
 WHERE "code" IS NOT NULL AND "file_count" IS NULL;
