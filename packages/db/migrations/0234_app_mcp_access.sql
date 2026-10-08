-- Team apps Phase 1 (plan page b6dd688e): MCP on app data.
--
-- `apps.mcp_access`: may a member's or client's MCP connection reach this
-- app's data at all (app_data_list / _schema / _query / _write)? Off by
-- default: nothing an app holds is on MCP until an admin turns it on (only
-- the owner's app update route, PATCH /api/apps/:id, sets it). Read or write
-- still follows the login's Write switch and the Informational flag
-- (`data_read_only`), the same rule as the app's own broker in the browser.
--
-- The viewer roles read it (the access matrix grants it with the other app
-- columns at every migrate): the member and client app lookups run on those
-- roles.
--
-- `node_snapshots.trigger` gains `pre_mcp_write`: the first MCP write to an
-- app in an hour takes an automatic snapshot first, so one restore undoes it.
--
-- Rollback: the previous release never reads the column and serves no
-- app_data_* tool. It never writes a `pre_mcp_write` row; the rows this
-- release wrote stay valid under the wider check.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

ALTER TABLE "public"."apps"
  ADD COLUMN IF NOT EXISTS "mcp_access" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" DROP CONSTRAINT IF EXISTS "node_snapshots_trigger_ck";
--> statement-breakpoint
ALTER TABLE "public"."node_snapshots" ADD CONSTRAINT "node_snapshots_trigger_ck" CHECK ("trigger" IN
  ('publish', 'commit', 'manual', 'pre_restore', 'pre_schema', 'pre_delete', 'pre_import', 'nightly',
   'pre_mcp_write'));
