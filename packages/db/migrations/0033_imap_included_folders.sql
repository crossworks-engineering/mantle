-- Explicit per-account IMAP folder include-list.
-- Complements `imap_excluded_folders` (opt-out). When NULL or empty, the
-- adapter keeps its current behaviour: auto-discover every server folder
-- minus the exclusions. When non-empty, the adapter scans ONLY the listed
-- folders (still intersected with the server's real folder list and minus
-- exclusions, as a safety net).
--
-- Nullable, no default, so every existing account stays on the legacy
-- discover-minus-exclude path until the operator opts a folder set in via
-- the per-account folder-config UI.

alter table "public"."email_accounts"
  add column if not exists "imap_included_folders" text[];
