-- Apps audit 2026-10-02 (low): an app's error rows (app_errors, the Activity
-- tab, the reaper's per-app cap in packages/content/src/app-access-log.ts)
-- were read through the app's whole access trail. A partial index on the
-- error rows only. Additive.
CREATE INDEX IF NOT EXISTS "app_access_log_error_idx"
  ON "public"."app_access_log" ("app_node_id", "created_at" DESC)
  WHERE "kind" = 'error';
