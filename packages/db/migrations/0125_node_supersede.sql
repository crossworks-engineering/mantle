-- Content currency layer, slice 1 (task 30e70143): node-level supersession.
--
-- `superseded_by` lifts the facts-layer lineage primitive (facts.superseded_by,
-- migration history) up to content nodes: an old uploaded file superseded by
-- the corrected page built from it, an older versioned export superseded by the
-- newest sibling, or any node explicitly marked outdated. Ranking demotion is
-- MATERIALIZED into the existing `salience` column at write time (the
-- `dist + λ·(1-salience)` expression already runs in every read path), so this
-- migration changes no query plans. `superseded_reason` records why:
-- 'version' (filename-family sibling), 'migrated' (page built from the source),
-- 'corrected' (explicit mark). Forward-only additive; safe to re-run.

alter table "nodes"
  add column if not exists "superseded_by" uuid;--> statement-breakpoint

alter table "nodes"
  add column if not exists "superseded_reason" text;--> statement-breakpoint

-- Successor-chain walks + "what supersedes X" reverse lookups touch only the
-- (rare) superseded rows — a partial index keeps it free for everything else.
create index if not exists "nodes_superseded_by_idx"
  on "nodes" ("superseded_by")
  where "superseded_by" is not null;
