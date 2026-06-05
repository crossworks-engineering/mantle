-- Tools & Skills split, Phase 6b safety net (docs/tools-and-skills.md): backfill
-- tool-group grants for an ESTABLISHED brain that reaches this migration with
-- empty `agents.tool_group_slugs`.
--
-- Why this exists: 0080 added `tool_group_slugs` empty; the re-expression of old
-- per-agent `tool_slugs` onto groups was done by a throwaway dev script (since
-- deleted), NOT a migration; 0083 then dropped `tool_slugs`. So a brain that runs
-- 0080..0083 WITHOUT that script loses every specialist's capability (custom-role
-- agents the boot self-heal never touches) the moment the column drops. This
-- restores the canonical manifest agents BY SLUG (no dependency on the
-- now-dropped column), so it works post-0083.
--
-- Scope: the 6 manifest agents only, and ONLY when their grant is still empty
-- ('{}'). Operator-owned personas (telegram-default, apostle-paul) are not
-- manifest slugs and are intentionally NOT touched here — the boot self-heal
-- (apps/agent ensureCoreToolsOnConversationalAgents → CORE_AUTO_GRANT_GROUP_SLUGS)
-- floors every enabled responder/assistant to a functional group set, including
-- the canonical persona if it exists. The group lists below are a point-in-time
-- snapshot of MANIFEST_AGENTS at v0.20.x; migrations are frozen by design.
--
-- Idempotent + safe on every deployment shape:
--   * fresh install  → no agent rows exist yet (onboarding seeds them later with
--                       full grants) → matches nothing, no-op.
--   * dev (this brain)→ specialists already carry non-empty groups → no-op;
--                       the persona is telegram-default (not 'assistant') → no-op.
--   * established brain that lost grants at 0083 → restores them here.

UPDATE "agents" SET "tool_group_slugs" = ARRAY[
  'memory-core','files','notes','events','todos','contacts','lifelog','recall',
  'email','persona','media-workers','delegation','messaging','secrets','ingest',
  'tool-results','page-share'
]::text[], "updated_at" = now()
WHERE "slug" = 'assistant' AND "tool_group_slugs" = '{}'::text[];
--> statement-breakpoint
UPDATE "agents" SET "tool_group_slugs" = ARRAY[
  'pages','page-admin','page-share','files','memory-core'
]::text[], "updated_at" = now()
WHERE "slug" = 'pages' AND "tool_group_slugs" = '{}'::text[];
--> statement-breakpoint
UPDATE "agents" SET "tool_group_slugs" = ARRAY[
  'tables','files','memory-core'
]::text[], "updated_at" = now()
WHERE "slug" = 'tables' AND "tool_group_slugs" = '{}'::text[];
--> statement-breakpoint
UPDATE "agents" SET "tool_group_slugs" = ARRAY[
  'recall','recall-search','memory-core'
]::text[], "updated_at" = now()
WHERE "slug" = 'remy' AND "tool_group_slugs" = '{}'::text[];
--> statement-breakpoint
UPDATE "agents" SET "tool_group_slugs" = ARRAY[
  'research','memory-core'
]::text[], "updated_at" = now()
WHERE "slug" = 'researcher' AND "tool_group_slugs" = '{}'::text[];
--> statement-breakpoint
UPDATE "agents" SET "tool_group_slugs" = ARRAY[
  'terminal','files','memory-core'
]::text[], "updated_at" = now()
WHERE "slug" = 'coder' AND "tool_group_slugs" = '{}'::text[];
