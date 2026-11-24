-- The Scan reader's model moves to a closed lab model (2026-11-24).
--
-- The Scan reader's model is the chat model OpenRouter's mistral-ocr parser
-- hands a page's text to (SCAN_READER_MODEL, server/web/lib/system-manifest/
-- manifest.ts). It was meta-llama/llama-3.1-8b-instruct, an open-weight model
-- that third-party hosts serve, so the text of a scanned page could reach one
-- of them. It is now openai/gpt-6-luna, which OpenRouter serves only from
-- OpenAI, Azure or Amazon Bedrock (the fact workers' model too).
--
-- The boot reconcile never changes an existing worker's model (an operator's
-- cost choice), so this one data change moves the boxes. It moves a route
-- only while it is still on the old shipped default, exactly: a model
-- someone picked by hand is kept. Primary and backup route each on their
-- own. Every other column (provider, key, base URL, params) stays.
--
-- Plain data, no trigger, no job. Idempotent: a second run finds nothing.
-- A brain with no Scan reader (no OpenRouter key) has no row: a no-op.
--
-- Rollback: packages/db/rollback/0397_scan_reader_lab_model.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."ai_workers"
SET "model" = 'openai/gpt-6-luna', "updated_at" = now()
WHERE "kind" = 'scan_reader'
  AND "provider" = 'openrouter'
  AND "model" = 'meta-llama/llama-3.1-8b-instruct';
--> statement-breakpoint
UPDATE "public"."ai_workers"
SET "backup_model" = 'openai/gpt-6-luna', "updated_at" = now()
WHERE "kind" = 'scan_reader'
  AND "backup_provider" = 'openrouter'
  AND "backup_model" = 'meta-llama/llama-3.1-8b-instruct';
