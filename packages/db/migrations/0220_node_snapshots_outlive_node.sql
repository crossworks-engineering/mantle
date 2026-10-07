-- An app's history outlives the app (apps first-class plan, Phase 3: the
-- trash). Deleting an app now takes a `pre_delete` snapshot first, and that
-- snapshot, with the rest of the app's history, stays for 30 days so the app
-- can be restored with the same id (packages/content/src/app-trash.ts). A
-- nightly purge removes it after that. So the rows no longer cascade with
-- the node: node_id becomes a plain id, like prompt_versions.entity_id.
ALTER TABLE "public"."node_snapshots" DROP CONSTRAINT IF EXISTS "node_snapshots_node_id_fkey";
