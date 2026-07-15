-- Tables v2 (sqlite-native storage) — registry columns on the `tables` sidecar.
--
-- The Postgres row becomes the REGISTRY + COORDINATION POINT for a per-node
-- sqlite workbook file: `storage_path` set ⇒ the file is the source of truth
-- (JSONB `data`/`draft_data` retained through the transition as migration
-- source + rollback); NULL ⇒ legacy JSONB path. Draft/commit/migration writers
-- serialize on this row via SELECT … FOR UPDATE.
--
-- `stats` carries per-tab row/column counts so listTables can serve counts
-- without opening files OR parsing JSONB (today it parses full `data` per row
-- just for counts — the rewrite lands with the engine, the column lands here).
-- `draft_rev` is the etag the UI autosave must present so a debounced stale
-- doc can never overwrite newer agent ops.
--
-- Purely additive; every column nullable or defaulted — old code paths are
-- untouched until the engine starts setting `storage_path`.

alter table "public"."tables"
  add column if not exists "storage_path" text,
  add column if not exists "size_bytes" bigint,
  add column if not exists "shape_hash" text,
  add column if not exists "engine_version" integer,
  add column if not exists "stats" jsonb,
  add column if not exists "draft_rev" integer default 0 not null;
