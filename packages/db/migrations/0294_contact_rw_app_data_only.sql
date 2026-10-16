-- A8 matrix F9 (workspaces arch plan v2 page fcc4aee4; docs/actors.md, "A8
-- matrix"; docs/edit-check.md, "A contact share writes its app's data
-- only"): a contact share with Can write (mantle.actor 'contact:rw', set
-- only by the /s gate, server/web/lib/contact-share-gate.ts) runs its write
-- as named system work on the system pool, where nothing but a snapshot
-- copy's read-only rule held a statement it sent. The guide: a contact
-- share writes only its app's data. The /s broker sends nothing else; this
-- is the database's own line behind it (defence in depth).
--
-- mantle_edit_check_contact, a statement trigger next to
-- mantle_edit_check_ro (0280, section 5), on every item table (those of
-- mantle_actor_check_tables()) but two, WHEN mantle.actor = 'contact:rw':
-- the statement is refused through the edit check's gate (warn reports it,
-- on refuses it, 42501 detail ro_actor; off: its triggers are disabled, as
-- every edit check trigger). Its name is of the edit check's family, so
-- mantle_set_edit_check switches it with the others; migrate's sync leaves
-- it alone (access-matrix.ts EDIT_CHECK_MIGRATION_TRIGGERS).
--
-- What a contact:rw request writes, traced through every /s route
-- (server/web/app/s/[token]/* and server/web/server/pages/share.tsx), and
-- why each is or is not held here:
--  - app_databases (app-broker.ts: the provisioning row, its size and use
--    stamps; markAppClientWritten's client_written_at): its app's data.
--    The one item table left out.
--  - node_acl_head: a heads lock is not a change (left out as by 0280).
--  - app_table_exports (the dirty stamp) and the export sync's Table
--    writes (nodes, tables, ...): bound to system(app-export) in
--    packages/content/src/app-table-exports.ts, never the request's actor,
--    so they pass.
--  - shares (the view counter): system(backfill:link-views), a named
--    read-path write. contact_share_codes (the code route): before the gate
--    names the contact, so never as contact:rw.
--  - share_access_log, app_access_log, app_errors, the tool broker's audit
--    rows: log tables, not item tables (no trigger).
-- Re-runnable.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_edit_contact_stmt"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  -- A cascade's inner statements are skipped (their source is checked).
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  PERFORM "public"."mantle_edit_refuse"(
    format('%s on %s: a contact share writes its app''s data only', TG_OP, TG_TABLE_NAME),
    'ro_actor', 'not allowed to change this: a contact share writes its app''s data only');
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_edit_contact_stmt"() FROM PUBLIC;
--> statement-breakpoint
-- The migration-made edit check triggers of an item table, installed by one
-- loop (the read-only refusal of 0280, section 5, and this one): a migration
-- that adds an item table calls it, so neither trigger is left off a new
-- table. CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE, not the
-- ACCESS EXCLUSIVE of a DROP TRIGGER: reads go on while it runs on a live
-- box. A replaced trigger comes back enabled, so the box mode is applied
-- after the loop: disabled on a box that is off.
CREATE OR REPLACE FUNCTION "public"."mantle_edit_check_item_triggers"()
  RETURNS integer LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  t regclass;
  n integer := 0;
BEGIN
  -- Every item table but the heads rows (a heads lock is not a change).
  FOR t IN SELECT c.tbl FROM "public"."mantle_actor_check_tables"() c
            WHERE c.tbl <> 'public.node_acl_head'::regclass LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER mantle_edit_check_ro BEFORE INSERT OR UPDATE OR DELETE ON %s '
      'FOR EACH STATEMENT WHEN (current_setting(''mantle.write_mode'', true) = ''ro'') '
      'EXECUTE FUNCTION "public"."mantle_edit_ro_stmt"()', t);
    n := n + 1;
    -- A contact share writes its app's data: app_databases is left out.
    CONTINUE WHEN t = 'public.app_databases'::regclass;
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER mantle_edit_check_contact BEFORE INSERT OR UPDATE OR DELETE ON %s '
      'FOR EACH STATEMENT WHEN (current_setting(''mantle.actor'', true) = ''contact:rw'') '
      'EXECUTE FUNCTION "public"."mantle_edit_contact_stmt"()', t);
    n := n + 1;
  END LOOP;
  PERFORM "public"."mantle_edit_check_triggers"("public"."mantle_check_box_mode"('edit_check') <> 'off', 50);
  RETURN n;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_edit_check_item_triggers"() FROM PUBLIC;
--> statement-breakpoint
SELECT "public"."mantle_edit_check_item_triggers"();
