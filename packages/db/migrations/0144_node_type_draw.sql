-- Adds 'draw' to the node_type enum. Lives in its own file because
-- `ALTER TYPE ... ADD VALUE` cannot run in the same transaction that later
-- references the new value; isolating it sidesteps that (same reason as the
-- 0008 / 0037 / 0067 / 0069 / 0075 / 0136 enum-add migrations).
--
-- A draw is an Excalidraw whiteboard scene: a nodes row with type='draw'
-- plus a `draws` sidecar (0145) holding the scene JSON. See docs/draw-plan.md.

alter type "public"."node_type" add value if not exists 'draw';
