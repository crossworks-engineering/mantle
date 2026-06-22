-- Per-owner embedding/extraction throughput tuning, surfaced on the
-- /settings/embedding "Performance & throughput" section. All nullable — null
-- falls back to the env var (EXTRACT_CONCURRENCY / MANTLE_EXTRACT_EXPIRE_MIN /
-- MANTLE_LOCAL_EMBED_BATCH / MANTLE_LOCAL_EMBED_TIMEOUT_MS) and then the code
-- default, so existing installs are unchanged. Purely additive; `if not exists`
-- keeps a partial replay safe.
alter table "public"."embedding_config" add column if not exists "extraction_concurrency" integer;
--> statement-breakpoint
alter table "public"."embedding_config" add column if not exists "extraction_time_budget_minutes" integer;
--> statement-breakpoint
alter table "public"."embedding_config" add column if not exists "local_embed_batch_size" integer;
--> statement-breakpoint
alter table "public"."embedding_config" add column if not exists "local_embed_request_timeout_ms" integer;
