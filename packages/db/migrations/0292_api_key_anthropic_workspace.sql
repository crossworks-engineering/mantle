-- An optional Anthropic workspace id on a stored API key. A key not scoped
-- to an Anthropic workspace must name one on every call (header
-- anthropic-workspace-id), else Anthropic answers 400; the id is set on the
-- key in Settings and sent by the Anthropic adapter (anthropic-headers.ts).
-- Not secret, so plain text beside the ciphertext; null = no workspace id,
-- behaviour as before. Only an 'anthropic' key may carry one, and only in
-- ASCII letters, digits, _ and - (1 to 128 of them), the same pattern the
-- app checks (ANTHROPIC_WORKSPACE_ID_RE in @mantle/voice-client): a header
-- value must be ASCII.
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
        AND "anthropic_workspace_id" ~ '^[A-Za-z0-9_-]{1,128}$')
  );
