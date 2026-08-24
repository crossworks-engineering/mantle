-- "Recall" now names the memory-map system (docs/recall.md, migration 0153);
-- Remy's conversation-replay feature is renamed "Replay" (docs/replay.md).
-- The tool slug recall_window -> replay_window and the group slugs
-- recall -> replay, recall-search -> replay-search change in the manifest;
-- this converges the LIVE rows the same way so agents keep their grants
-- through the roll instead of waiting on (or fighting) reconcile.
UPDATE "tool_groups"
   SET "tool_slugs" = array_replace("tool_slugs", 'recall_window', 'replay_window')
 WHERE 'recall_window' = ANY("tool_slugs");
--> statement-breakpoint
-- Guarded per owner: if an operator already made their own `replay` group,
-- leave their `recall` group alone and let reconcile report the drift.
UPDATE "tool_groups" tg
   SET "slug" = 'replay', "name" = 'Replay'
 WHERE tg."slug" = 'recall'
   AND NOT EXISTS (
     SELECT 1 FROM "tool_groups" x
      WHERE x."owner_id" = tg."owner_id" AND x."slug" = 'replay'
   );
--> statement-breakpoint
UPDATE "tool_groups" tg
   SET "slug" = 'replay-search', "name" = 'Replay search'
 WHERE tg."slug" = 'recall-search'
   AND NOT EXISTS (
     SELECT 1 FROM "tool_groups" x
      WHERE x."owner_id" = tg."owner_id" AND x."slug" = 'replay-search'
   );
--> statement-breakpoint
-- The agent rewrites carry the SAME per-owner guard as the group renames
-- above: they run only where the owner's `recall`/`recall-search` group was
-- actually renamed (no old-slug row remains, a new-slug row exists). Where
-- the guard skipped the rename, agents keep pointing at the owner's own
-- surviving group instead of being silently repointed at a different one.
UPDATE "agents" a
   SET "tool_group_slugs" = array_replace("tool_group_slugs", 'recall', 'replay')
 WHERE 'recall' = ANY("tool_group_slugs")
   AND NOT EXISTS (
     SELECT 1 FROM "tool_groups" tg
      WHERE tg."owner_id" = a."owner_id" AND tg."slug" = 'recall'
   )
   AND EXISTS (
     SELECT 1 FROM "tool_groups" tg
      WHERE tg."owner_id" = a."owner_id" AND tg."slug" = 'replay'
   );
--> statement-breakpoint
UPDATE "agents" a
   SET "tool_group_slugs" = array_replace("tool_group_slugs", 'recall-search', 'replay-search')
 WHERE 'recall-search' = ANY("tool_group_slugs")
   AND NOT EXISTS (
     SELECT 1 FROM "tool_groups" tg
      WHERE tg."owner_id" = a."owner_id" AND tg."slug" = 'recall-search'
   )
   AND EXISTS (
     SELECT 1 FROM "tool_groups" tg
      WHERE tg."owner_id" = a."owner_id" AND tg."slug" = 'replay-search'
   );
