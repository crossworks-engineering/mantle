-- Workspaces arch A3b, store brokers (docs/store-brokers.md, plan 20.3):
-- the rows a store broker checks and flips.
--
-- A broker writes a store's bytes under a NEW revision name, then one short
-- transaction checks the row as the caller (exactly one row) and points it
-- at the new revision; what no row points at any more, the sweep removes.
--
-- 1. tables.draft_path: the table's draft workbook, relative to
--    TABLE_DB_DIR; null when there is no draft. The published workbook is
--    storage_path, as before; both now change name with each revision.
--    A draft written before this migration sits beside the published file
--    (<node>.draft.sqlite): every row with an unsaved draft gets that path
--    (draft_updated_at is set by every draft write and cleared by a commit
--    or a discard).
-- 2. app_databases.write_seq: the app database's write revision, bumped as
--    the caller by every write (an app's single statement commits it before
--    the statement runs, in place); a restore flips storage_path to a new
--    file.
--
-- Constant defaults: no table rewrite. Both locks first, in one statement
-- (a migration that alters several tables never waits holding one).
LOCK TABLE public.tables, public.app_databases IN ACCESS EXCLUSIVE MODE;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS draft_path text;
UPDATE tables
   SET draft_path = regexp_replace(storage_path, '\.sqlite$', '.draft.sqlite')
 WHERE storage_path IS NOT NULL AND draft_updated_at IS NOT NULL AND draft_path IS NULL;
ALTER TABLE app_databases ADD COLUMN IF NOT EXISTS write_seq bigint NOT NULL DEFAULT 0;
