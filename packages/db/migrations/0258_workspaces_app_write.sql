-- Workspaces, phase W5b1 fix round 1, the data pass of 0257's L1 (the W5b1
-- audit): Team Write comes off every public app on a migrated brain. Its own
-- migration, so the heads are the first lock of this transaction (W1). The
-- drift is computed once (fix round 2, L-c), its heads taken, and only those
-- items are applied. Row locks only. Nothing on a brain that is not migrated
-- or has no public team app. No LLM work, no extractor notify.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
DO $$
DECLARE
  ids uuid[] := ARRAY(SELECT "public"."mantle_bridge_drift_ids"());
BEGIN
  IF cardinality(ids) > 0 THEN
    PERFORM "public"."mantle_lock_heads"(ids, 'update');
    PERFORM "public"."mantle_bridge_apply"(ids);
  END IF;
END
$$;
