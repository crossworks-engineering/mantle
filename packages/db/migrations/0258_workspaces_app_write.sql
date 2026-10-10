-- Workspaces, phase W5b1 fix round 1, the data pass of 0257's L1 (the W5b1
-- audit): Team Write comes off every public app on a migrated brain. Its own
-- migration, so the heads are the first lock of this transaction (W1). Row
-- locks only: the heads of the items that drift, then their bridge rows.
-- Nothing on a brain that is not migrated or has no public team app.
-- No LLM work, no extractor notify.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
SELECT "public"."mantle_lock_heads"(ARRAY(SELECT "public"."mantle_bridge_drift_ids"()), 'update');
--> statement-breakpoint
SELECT "public"."mantle_bridge_apply"(ARRAY(SELECT "public"."mantle_bridge_drift_ids"()));
