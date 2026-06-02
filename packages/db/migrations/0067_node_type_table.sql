-- Adds 'table' to the node_type enum. Lives in its own file because
-- `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction that later
-- references the new value; isolating it sidesteps that (same reason as the
-- 0008 / 0037 enum-add migrations). The `tables` sidecar lands in 0068.

alter type "public"."node_type" add value if not exists 'table';
