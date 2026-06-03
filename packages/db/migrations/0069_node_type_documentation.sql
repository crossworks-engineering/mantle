-- Adds 'documentation' to the node_type enum. Lives in its own file because
-- `ALTER TYPE ... ADD VALUE` cannot run in the same transaction that later
-- references the new value; isolating it sidesteps that (same reason as the
-- 0008 / 0037 / 0067 enum-add migrations). The `doc_collections` opt-in table
-- lands in 0070.

alter type "public"."node_type" add value if not exists 'documentation';
