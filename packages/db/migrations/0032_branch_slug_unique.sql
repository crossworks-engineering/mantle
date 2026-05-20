-- Folders (branch nodes) are uniquely identified by their ltree path
-- (nodes_branch_owner_path_uq), not by slug. Two folders under different
-- parents may legitimately share a name — most concretely, each upload
-- surface's dated subfolder `…/<YYYY-MM-DD>` (assistant-uploads,
-- telegram-uploads, generated-images, …). The original nodes_owner_slug_uq
-- made slugs globally unique per owner, which silently blocked the second
-- surface that tried to create a same-day folder (its INSERT hit the unique
-- index and was swallowed as a "duplicate", so the folder was never created).
--
-- Scope slug-uniqueness to NON-branch nodes (notes/files/etc. keep their
-- stable unique slug); branches rely on path-uniqueness instead. The new
-- index is a strict subset of the old one, so no existing row can violate it.
drop index if exists "nodes_owner_slug_uq";
create unique index if not exists "nodes_owner_slug_uq"
  on "public"."nodes"("owner_id", "slug")
  where "slug" is not null and "type" <> 'branch';
