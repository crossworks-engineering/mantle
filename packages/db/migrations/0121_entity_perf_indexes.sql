-- Entity-graph read/ingest performance indexes (audit 2026-07-16, perf finding).
--
-- 1. entities.aliases GIN. The exact-resolve query in reconcileEntity /
--    searchEntities is `owner_id = X AND (lower(name) = Y OR Y = any(aliases))`.
--    lower(name) is already served by entities_owner_lname_kind_uq (0055), but
--    the `= any(aliases)` OR branch had no index — and an OR where one side is
--    unindexed forces Postgres to seq-scan the whole owner's entity set. That
--    ran once per exact-resolve, and at INGEST once per @-mention (amplified).
--    A GIN on aliases makes both OR branches indexable, so the planner can
--    BitmapOr instead of scanning.
--
-- 2. entity_edges (owner_id, relation) WHERE valid_to IS NULL. The dashboard's
--    edgesByRelation / graphIntegrity aggregates filter `owner_id = X AND
--    valid_to IS NULL` and GROUP BY relation; the existing
--    (source_id,relation) / (target_id,relation) indexes don't apply (no
--    source/target constraint), so both full-scanned + hash-aggregated the
--    entire edge table on every landing-page render. A partial index on the
--    current edges keyed by (owner_id, relation) serves the grouped count.
--
-- Both are additive `create index if not exists`; safe to re-run, and plain
-- (non-CONCURRENTLY) so they run inside the migration's transaction. The entity
-- tables are small (thousands of rows) so the brief build lock is negligible.

create index if not exists "entities_aliases_gin_idx"
  on "public"."entities" using gin ("aliases");
--> statement-breakpoint
create index if not exists "entity_edges_owner_current_idx"
  on "public"."entity_edges" ("owner_id", "relation")
  where "valid_to" is null;
