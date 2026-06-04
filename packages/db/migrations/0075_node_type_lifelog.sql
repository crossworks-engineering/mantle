-- Adds 'lifelog' to the node_type enum. Lives in its own file because
-- `ALTER TYPE ... ADD VALUE` cannot run in the same transaction that later
-- references the new value; isolating it sidesteps that (same reason as the
-- 0008 / 0037 / 0067 / 0069 enum-add migrations).
--
-- Life Logs are a note-like content type (lives entirely in nodes.data, no
-- sidecar): short plain-text entries with a mood + category, a personal
-- life-log that feeds the always-on "who you are" identity context injected
-- into every agent turn (see docs/lifelog.md).

alter type "public"."node_type" add value if not exists 'lifelog';
