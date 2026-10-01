-- File nodes: slug-uniqueness per FOLDER, not per owner (step 2 of 2).
--
-- 0184 added nodes_file_owner_path_slug_uq (owner, path, slug) for files.
-- Now take files out of the owner-wide index, so the same filename can live
-- in two folders. Other non-branch types keep the owner-wide slug rule
-- unchanged; branches stay out of it as in 0032. The new predicate is a
-- strict subset of the old one, so no existing row can violate it.
drop index if exists "nodes_owner_slug_uq";
create unique index if not exists "nodes_owner_slug_uq"
  on "public"."nodes"("owner_id", "slug")
  where "slug" is not null and "type" not in ('branch', 'file');
