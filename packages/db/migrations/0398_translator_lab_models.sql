-- The Translator's fallback and high models move to closed lab models
-- (2026-11-24).
--
-- The Translator worker names two more models in its params:
-- `fallback_model` (takes a part only when the worker's model fails it) and
-- `high_model` (runs a call that asks quality 'high'). They were
-- mistralai/mistral-small-2603 and mistralai/mistral-medium-3-5, open-weight
-- models that third-party hosts may serve, so the text sent to translate
-- could reach one of them. They are now openai/gpt-6-luna and
-- anthropic/claude-sonnet-5.5, which OpenRouter serves only from their lab,
-- Azure, Amazon Bedrock or Google (server/web/lib/system-manifest/
-- manifest.ts).
--
-- The boot reconcile never changes an existing worker's params, so this one
-- data change moves the boxes. It moves each key only while it is still
-- exactly the old shipped model: a model someone picked by hand is kept.
-- Each key on its own. Every other key and column stays.
--
-- The Translator pool's two template rows (curated_models, seeded from
-- @mantle/client-types model-pools-data.json) move too, so a model combo
-- does not offer the old models as the shipped ones: only a row still
-- exactly the shipped one (pool translator, the template's name, the old
-- one-route list, a note that starts "the shipped fallback" or "the shipped
-- high model"). A row edited by hand (its name, routes or note) is kept.
-- The name is unique per owner and pool, so an owner has at most one such
-- row per model. Where the box already has a row of that pool with the new
-- name, the old row is deleted instead of renamed.
--
-- Plain data, no trigger, no job. Idempotent: a second run finds nothing.
-- A brain with no Translator has no row: a no-op.
--
-- Rollback: packages/db/rollback/0398_translator_lab_models.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."ai_workers"
SET "params" = jsonb_set("params", '{fallback_model}', '"openai/gpt-6-luna"'::jsonb),
    "updated_at" = now()
WHERE "kind" = 'translator'
  AND "provider" = 'openrouter'
  AND "params"->>'fallback_model' = 'mistralai/mistral-small-2603';
--> statement-breakpoint
UPDATE "public"."ai_workers"
SET "params" = jsonb_set("params", '{high_model}', '"anthropic/claude-sonnet-5.5"'::jsonb),
    "updated_at" = now()
WHERE "kind" = 'translator'
  AND "provider" = 'openrouter'
  AND "params"->>'high_model' = 'mistralai/mistral-medium-3-5';
--> statement-breakpoint
DELETE FROM "public"."curated_models" AS "old"
WHERE "old"."pool" = 'translator'
  AND "old"."name" = 'Mistral: Mistral Small 2603'
  AND "old"."routes" = '[{"provider":"openrouter","model":"mistralai/mistral-small-2603"}]'::jsonb
  AND "old"."note" LIKE 'the shipped fallback%'
  AND EXISTS (
    SELECT 1 FROM "public"."curated_models" AS "new"
    WHERE "new"."owner_id" = "old"."owner_id"
      AND "new"."pool" = 'translator'
      AND "new"."name" = 'OpenAI: GPT-6 Luna'
  );
--> statement-breakpoint
UPDATE "public"."curated_models"
SET "name" = 'OpenAI: GPT-6 Luna',
    "vendor" = 'OpenAI',
    "routes" = '[{"provider":"openrouter","model":"openai/gpt-6-luna"}]'::jsonb,
    "pricing" = '{"inputPerM":0.1,"outputPerM":0.5,"currency":"USD","capturedAt":"2026-11-24T09:00:00.000Z","source":"openrouter"}'::jsonb,
    "rating" = 4,
    "note" = 'the shipped fallback: takes a part only when the primary fails it; another lab than the primary and the high model; a closed lab model, served only by OpenAI, Azure or Amazon Bedrock; 1M context',
    "updated_at" = now()
WHERE "pool" = 'translator'
  AND "name" = 'Mistral: Mistral Small 2603'
  AND "routes" = '[{"provider":"openrouter","model":"mistralai/mistral-small-2603"}]'::jsonb
  AND "note" LIKE 'the shipped fallback%';
--> statement-breakpoint
DELETE FROM "public"."curated_models" AS "old"
WHERE "old"."pool" = 'translator'
  AND "old"."name" = 'Mistral: Mistral Medium 3.5'
  AND "old"."routes" = '[{"provider":"openrouter","model":"mistralai/mistral-medium-3-5"}]'::jsonb
  AND "old"."note" LIKE 'the shipped high model%'
  AND EXISTS (
    SELECT 1 FROM "public"."curated_models" AS "new"
    WHERE "new"."owner_id" = "old"."owner_id"
      AND "new"."pool" = 'translator'
      AND "new"."name" = 'Anthropic: Claude Sonnet 5.5'
  );
--> statement-breakpoint
UPDATE "public"."curated_models"
SET "name" = 'Anthropic: Claude Sonnet 5.5',
    "vendor" = 'Anthropic',
    "routes" = '[{"provider":"openrouter","model":"anthropic/claude-sonnet-5.5"}]'::jsonb,
    "pricing" = '{"inputPerM":2,"outputPerM":10,"currency":"USD","capturedAt":"2026-11-24T09:00:00.000Z","source":"openrouter"}'::jsonb,
    "rating" = 4,
    "note" = 'the shipped high model: quality ''high'' only, for terminology or style work; a closed lab model, served only by Anthropic, Azure, Amazon Bedrock or Google; 1M context',
    "updated_at" = now()
WHERE "pool" = 'translator'
  AND "name" = 'Mistral: Mistral Medium 3.5'
  AND "routes" = '[{"provider":"openrouter","model":"mistralai/mistral-medium-3-5"}]'::jsonb
  AND "note" LIKE 'the shipped high model%';
