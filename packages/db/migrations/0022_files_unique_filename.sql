-- Files-API support: guarantee no duplicate filenames inside the same
-- folder for `type='file'` nodes. The application layer already
-- lowercases + sanitises filenames before insert, so an exact-string
-- comparison is the right test.
--
-- The `files` root branch itself isn't seeded here — it's created
-- lazily by the folder API on first access, which keeps migrations
-- pure-schema and resilient to fresh-database installs that haven't
-- yet inserted an auth.users row.

CREATE UNIQUE INDEX IF NOT EXISTS file_filename_in_parent_uq
  ON nodes (owner_id, path, ((data ->> 'filename')))
  WHERE type = 'file' AND data ? 'filename';

-- Speed up "list folder contents" queries.
CREATE INDEX IF NOT EXISTS file_owner_path_idx
  ON nodes (owner_id, path)
  WHERE type = 'file';
