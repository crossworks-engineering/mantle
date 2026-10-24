-- Adds 'present' to the node_type enum. Lives in its own file because
-- `ALTER TYPE ... ADD VALUE` cannot run in the same transaction that later
-- references the new value (same reason as 0144 for 'draw').
--
-- A present is a Present canvas: a nodes row with type='present' plus a
-- `presents` sidecar (0332) holding the agent-written HTML document. See
-- docs/proposals/canvas-files.md.

alter type "public"."node_type" add value if not exists 'present';
