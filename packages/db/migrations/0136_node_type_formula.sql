-- Adds 'formula' to the node_type enum. Lives in its own file because
-- `ALTER TYPE ... ADD VALUE` cannot run in the same transaction that later
-- references the new value; isolating it sidesteps that (same reason as the
-- 0008 / 0037 / 0067 / 0069 / 0075 enum-add migrations).
--
-- A formula is a declarative model of a calculation taken from a published
-- standard — expressions, branches, keyed lookup tables and classification
-- rubrics — stored entirely in nodes.data (no sidecar). See docs/formulas.md.

alter type "public"."node_type" add value if not exists 'formula';
