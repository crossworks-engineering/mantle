-- File nodes: slug-uniqueness per FOLDER, not per owner (step 1 of 2).
--
-- A file node's slug is its filename, and nodes_owner_slug_uq made that
-- unique across the whole brain. So two files with the same name in
-- DIFFERENT folders could not both be nodes: on 2026-09-28 the watcher found
-- files/church/the-tree-of-knowledge-….md AND files/church/sermons/<same
-- name>.md (different sermons), the second INSERT hit the index, and that
-- file stayed on disk with no node (invisible, unsearchable). file_copy into
-- another folder hit the same wall.
--
-- Nothing looks a file up by slug. Every file path keys a file by
-- (owner, folder path, filename): upsertFile, syncFileFromDisk,
-- deleteFileByPath, diskPathForFile. Share URLs and routes use node ids. So
-- the uniqueness a file needs is per folder, which is also what the disk
-- enforces. Folders went the same way in 0032 (path-unique, not slug-unique).
--
-- This index is implied by the old owner-wide one (owner, slug) for every
-- existing file row, so it cannot fail on current data. Step 2 (0185) then
-- takes files out of nodes_owner_slug_uq.
create unique index if not exists "nodes_file_owner_path_slug_uq"
  on "public"."nodes"("owner_id", "path", "slug")
  where "slug" is not null and "type" = 'file';
