-- Workspaces, phase W4a, part 3: the data pass (plan page 4887b8e7, sections
-- 9.1, 9.2, 9.4; the CEO's W4 decisions of 2026-10-10). The rules, functions
-- and triggers it uses are 0251, which committed first, so this transaction
-- takes no ACCESS EXCLUSIVE lock: only row locks on the rows it writes
-- (W4a re-audit 1). Reads and sign-ins carry on while it runs.
--
-- mantle_ws_migrate() writes the workspaces, the grants, the resources and
-- the R3 backfill once (skips a brain without an anchor, one already
-- migrated, and one with client logins or client-level items), repairs any
-- bridge drift, then runs the reach diff (9.4): a gain fails the migration
-- and nothing is written.
--
-- No LLM work, no extractor notify. Apps, app data and app-db files are not
-- touched: only grant rows are written.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
SELECT "public"."mantle_heads_bypass"('0252_workspaces_live_data');
--> statement-breakpoint
SELECT * FROM "public"."mantle_ws_migrate"();
--> statement-breakpoint
-- A brain migrated before (the function then skips): bring any item the
-- bridge left out of step to its level once. Nothing on a fresh run.
SELECT "public"."mantle_bridge_apply"(ARRAY(SELECT "public"."mantle_bridge_drift_ids"()));
