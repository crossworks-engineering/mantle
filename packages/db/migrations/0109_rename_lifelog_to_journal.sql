-- Rename the Life Logs / Memories surface to Journal at the storage layer,
-- completing the app-level lifelog → journal rename. Unlike the Tasks rename
-- (0108), the node TYPE itself was `lifelog`, so this also relabels the enum.
--
-- On Postgres 10+ `ALTER TYPE ... RENAME VALUE` relabels the enum element IN
-- PLACE: existing rows are the same physical element, so they read as 'journal'
-- instantly — no row rewrite, no backfill, no reindex — and it atomically covers
-- EVERY column of type node_type (nodes.type AND shares.node_type +
-- peer_shares.node_type). Unlike `ADD VALUE` it is reversible (rename back) and
-- has no same-transaction restriction, so this whole rename is one migration.
--
-- The remaining UPDATEs are the non-enum identifiers (same shape as 0108):
-- the ltree root label / branch node, the two tool-group slugs + the agents that
-- grant them, and the persona memory_config JSON (the inject flag + any
-- operator-customized extract_types list). Nothing here is queried-by — all
-- journal queries filter type='journal' — so it is a tidy-up, idempotent (the
-- WHERE clauses match nothing on a re-run), and fully reversible. Run BEFORE the
-- app boot reconcile so the renamed `journal` group already exists.

-- 1. Relabel the enum element in place (covers nodes + shares + peer_shares).
ALTER TYPE "public"."node_type" RENAME VALUE 'lifelog' TO 'journal';
--> statement-breakpoint
-- 2. The Journal branch: re-path + re-slug (old brains created it as path/slug 'lifelog').
UPDATE "nodes" SET "slug" = 'journal', "path" = 'journal'::ltree
  WHERE "type" = 'branch' AND "path" = 'lifelog'::ltree;
--> statement-breakpoint
-- 3. The branch's default title, only if the operator hasn't renamed it.
UPDATE "nodes" SET "title" = 'Journal'
  WHERE "type" = 'branch' AND "slug" = 'journal' AND "title" IN ('Memories', 'Life Logs');
--> statement-breakpoint
-- 4. Re-path every journal entry from the old flat root label to the new one.
UPDATE "nodes" SET "path" = 'journal'::ltree WHERE "path" = 'lifelog'::ltree;
--> statement-breakpoint
-- 5a. Rename the tool group (its membership already points at journal_* from the
--     app-level rename; seedToolCapabilities reaffirms it on reconcile).
UPDATE "tool_groups" SET "slug" = 'journal' WHERE "slug" = 'lifelog';
--> statement-breakpoint
-- 5b. Rename the admin tool group.
UPDATE "tool_groups" SET "slug" = 'journal-admin' WHERE "slug" = 'lifelog-admin';
--> statement-breakpoint
-- 6. Repoint every agent (persona + operator-authored) that grants either group.
UPDATE "agents" SET "tool_group_slugs" =
  array_replace(array_replace("tool_group_slugs", 'lifelog', 'journal'), 'lifelog-admin', 'journal-admin')
  WHERE 'lifelog' = ANY("tool_group_slugs") OR 'lifelog-admin' = ANY("tool_group_slugs");
--> statement-breakpoint
-- 7. Rename the persona memory_config flag key, preserving its boolean value.
UPDATE "agents" SET "memory_config" =
  ("memory_config" - 'inject_lifelog') || jsonb_build_object('inject_journal', "memory_config"->'inject_lifelog')
  WHERE "memory_config" ? 'inject_lifelog';
--> statement-breakpoint
-- 8. Safety net: any operator-customized extractor whose extract_types array
--    listed 'lifelog' (the manifest uses the default list, but live brains may
--    differ) — swap it to 'journal' so journal entries keep being extracted.
UPDATE "agents" SET "memory_config" = jsonb_set("memory_config", '{extract_types}',
  (SELECT jsonb_agg(CASE WHEN v::text = '"lifelog"' THEN '"journal"'::jsonb ELSE v END)
     FROM jsonb_array_elements("memory_config"->'extract_types') v))
  WHERE "memory_config"->'extract_types' @> '["lifelog"]'::jsonb;
