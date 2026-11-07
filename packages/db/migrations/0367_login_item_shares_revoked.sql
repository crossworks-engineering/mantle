-- No share shows a login's own item (per-login items, nodes.login_id set):
-- the share gate and the share view answer such a share not found (0366
-- made new ones impossible, for another login's item). A share made before,
-- an Admin user's contact share of another login's note, or an open link to
-- one's own screenshot, would otherwise stay live in the list of shares and
-- the share admin views. This revokes every live share whose item has a
-- login_id, as a revoke does (revoked_at now; the row and its access trail
-- stay). No other row changes, no table, no trigger, no LLM work.
-- Re-runnable: a second run finds no live one.
-- Revert: packages/db/rollback/0367_login_item_shares_revoked.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."shares" s SET "revoked_at" = now()
  FROM "public"."nodes" n
 WHERE n."id" = s."node_id" AND n."owner_id" = s."owner_id"
   AND n."login_id" IS NOT NULL AND s."revoked_at" IS NULL;
