-- Apps audit 2026-10-02, P7: the access-log reaper deletes rows older than
-- the retention window in batches (`where created_at < $cutoff limit 10000`,
-- packages/content/src/app-access-log.ts). The only index on created_at led
-- with app_node_id, so every batch scanned the whole table. Additive.
CREATE INDEX IF NOT EXISTS "app_access_log_created_idx" ON "public"."app_access_log" ("created_at");
