-- Entity-resolution integrity fix. The reconciler did SELECT-then-INSERT with
-- no unique constraint, so concurrent extractions of the same entity name
-- raced and created exact-duplicate entity rows (GitHub×2, iStore×3, …) — which
-- silently fragments the knowledge graph (a relation to one "GitHub" row and a
-- mention of the other never connect). This (a) merges existing exact dups into
-- a single canonical row, re-pointing every edge + fact to it, then (b) enforces
-- uniqueness so the race can never recreate them. The reconciler is also moved
-- to an upsert in the same change (apps/agent/src/extractor.ts).
--
-- Canonical = earliest-created row per (owner_id, lower(name), kind). Only EXACT
-- (case-insensitive name + same kind) dups are merged here — that's
-- unambiguously the same entity. Near-duplicates ("ACM Tech" vs "ACM Technology
-- CC") are a separate, judgement-calls concern and are NOT auto-merged.

-- 1. Re-point relation/mention edges: source side.
update entity_edges ed
set source_id = d.canon_id
from (
  select id, first_value(id) over (
    partition by owner_id, lower(name), kind order by created_at asc, id asc
  ) as canon_id from entities
) d
where ed.source_id = d.id and d.id <> d.canon_id;
--> statement-breakpoint

-- 2. Re-point edges: target side.
update entity_edges ed
set target_id = d.canon_id
from (
  select id, first_value(id) over (
    partition by owner_id, lower(name), kind order by created_at asc, id asc
  ) as canon_id from entities
) d
where ed.target_id = d.id and d.id <> d.canon_id;
--> statement-breakpoint

-- 3. Re-point facts to the canonical entity (preserve the link the FK's
--    ON DELETE SET NULL would otherwise drop).
update facts f
set entity_id = d.canon_id
from (
  select id, first_value(id) over (
    partition by owner_id, lower(name), kind order by created_at asc, id asc
  ) as canon_id from entities
) d
where f.entity_id = d.id and d.id <> d.canon_id;
--> statement-breakpoint

-- 4. Delete the non-canonical duplicates.
delete from entities e
using (
  select id, first_value(id) over (
    partition by owner_id, lower(name), kind order by created_at asc, id asc
  ) as canon_id from entities
) d
where e.id = d.id and d.id <> d.canon_id;
--> statement-breakpoint

-- 5. Enforce uniqueness: one entity per (owner, case-insensitive name, kind).
--    The reconciler's upsert relies on this constraint to make the race inert.
create unique index if not exists "entities_owner_lname_kind_uq"
  on "entities" (owner_id, lower(name), kind);
