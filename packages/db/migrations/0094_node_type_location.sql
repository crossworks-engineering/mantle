-- Adds 'location' to the node_type enum. Lives in its own file because
-- `ALTER TYPE ... ADD VALUE` cannot run in the same transaction that later
-- references the new value; isolating it sidesteps that (same reason as the
-- 0075 lifelog enum-add migration).
--
-- A `location` node is a RESOLVED place: coordinates the agent reverse-geocoded
-- into an address and saved for reuse (see packages/content/src/locations.ts).
-- It lives entirely in nodes.data (latitude/longitude/address/source/raw) — no
-- sidecar table needed.

alter type "public"."node_type" add value if not exists 'location';
