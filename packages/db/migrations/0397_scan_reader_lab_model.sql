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
-- The Scan reader pool's template row (curated_models, seeded from
-- @mantle/client-types model-pools-data.json) moves too, so a model combo
-- cannot put the worker back on the old model: only a row still exactly the
-- shipped one (pool scan_reader, the old one-route list, a note that starts
-- "the shipped default"). A row edited by hand is kept. Where the box
-- already has a row of that pool with the new name (the pool's names are
-- unique), the old row is deleted instead of renamed.
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
--> statement-breakpoint
DELETE FROM "public"."curated_models" AS "old"
WHERE "old"."pool" = 'scan_reader'
  AND "old"."routes" = '[{"provider":"openrouter","model":"meta-llama/llama-3.1-8b-instruct"}]'::jsonb
  AND "old"."note" LIKE 'the shipped default%'
  AND EXISTS (
    SELECT 1 FROM "public"."curated_models" AS "new"
    WHERE "new"."owner_id" = "old"."owner_id"
      AND "new"."pool" = 'scan_reader'
      AND "new"."name" = 'OpenAI: GPT-6 Luna'
  );
--> statement-breakpoint
UPDATE "public"."curated_models"
SET "name" = 'OpenAI: GPT-6 Luna',
    "vendor" = 'OpenAI',
    "routes" = '[{"provider":"openrouter","model":"openai/gpt-6-luna"}]'::jsonb,
    "pricing" = '{"inputPerM":0.1,"outputPerM":0.5,"currency":"USD","capturedAt":"2026-11-24T09:00:00.000Z","source":"openrouter"}'::jsonb,
    "rating" = 5,
    "note" = 'the shipped default: the chat model behind the mistral-ocr PDF parser (params.engine), which bills $2 per 1,000 pages; it answers 16 tokens, the text is the parser''s; a closed lab model, served only by OpenAI, Azure or Amazon Bedrock',
    "updated_at" = now()
WHERE "pool" = 'scan_reader'
  AND "routes" = '[{"provider":"openrouter","model":"meta-llama/llama-3.1-8b-instruct"}]'::jsonb
  AND "note" LIKE 'the shipped default%';
