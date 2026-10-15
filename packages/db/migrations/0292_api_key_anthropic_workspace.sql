-- An optional Anthropic workspace id on a stored API key. A key not scoped
-- to an Anthropic workspace must name one on every call (header
-- anthropic-workspace-id), else Anthropic answers 400; the id is set on the
-- key in Settings and sent by the Anthropic adapter (anthropic-headers.ts).
-- Not secret, so plain text beside the ciphertext; null = no workspace id,
-- behaviour as before. Only an 'anthropic' key may carry one.
--
-- 0292, not 0291: 0291 is the A6 grants migration (0291_a6_grant_reads). One
-- nullable column, no default to backfill, no rewrite, no trigger, no LLM
-- work. Re-runnable.
ALTER TABLE "public"."api_keys"
  ADD COLUMN IF NOT EXISTS "anthropic_workspace_id" text;

ALTER TABLE "public"."api_keys"
  DROP CONSTRAINT IF EXISTS "api_keys_anthropic_workspace_id_chk";
ALTER TABLE "public"."api_keys"
  ADD CONSTRAINT "api_keys_anthropic_workspace_id_chk" CHECK (
    "anthropic_workspace_id" IS NULL
    OR ("service" = 'anthropic'
        AND length("anthropic_workspace_id") BETWEEN 1 AND 128
        AND "anthropic_workspace_id" !~ '[[:space:][:cntrl:]]')
  );
