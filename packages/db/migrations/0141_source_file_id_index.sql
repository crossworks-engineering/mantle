-- Derived-node reap: make "what did this file produce?" indexable.
--
-- Ingest spawns derived nodes (extracted images, auto-imported tables, and
-- pages/notes/tables from the *_from_file tools) linked to their source only
-- through data.sourceFileId — JSONB, no FK. The reap path (countDerivedFromFile
-- / reapDerivedFromFile) and the dangling_source_file audit check both filter
-- on that key, so give it a partial expression index. Partial because the
-- overwhelming majority of nodes have no sourceFileId at all; the index stays
-- tiny and the planner can use it for both the per-file lookup and the
-- owner-wide audit scan.
create index if not exists "nodes_owner_source_file_id_idx"
  on "public"."nodes" ("owner_id", (("data"->>'sourceFileId')))
  where "data"->>'sourceFileId' is not null;
