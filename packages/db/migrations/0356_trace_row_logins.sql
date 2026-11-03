-- Every trace row names the login whose work it is (traces.login_id), so
-- the activity lists (the Activity column, the journey feed, /traces) show
-- each Admin user the system's work and its own, never another login's.
--
-- From this release every writer stamps the row (packages/tracing
-- rowLoginFor). Rows stored before it with no login are stamped here, once,
-- from what they already name:
--   1. a heartbeat fire: the login its fire answered (heartbeat_fires), the
--      anchor's (owner_id) when it answered none or has no fire row;
--   2. a run's trace (a run item's, or a resumed run's turn): the run's
--      login, the anchor's when the run names none;
--   3. a trace over a node that is one login's own: a per-login row
--      (nodes.login_id), or a node homed in that login's private workspace;
--   4. a delegated child (data.parent_trace_id, two levels): its parent's.
-- A row none of these names stays the system's. Only rows with no login
-- change; no stamped row is touched, so a re-run changes nothing.
--
-- Data only: no schema change, no trigger, no LLM work. traces has no
-- UPDATE trigger. Re-runnable.
-- Revert: packages/db/rollback/0356_trace_row_logins.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."traces" t
   SET "login_id" = coalesce(f."answered_by", t."owner_id")
  FROM "public"."heartbeat_fires" f
 WHERE f."trace_id" = t."id" AND t."login_id" IS NULL;
--> statement-breakpoint
UPDATE "public"."traces"
   SET "login_id" = "owner_id"
 WHERE "login_id" IS NULL AND "kind" = 'heartbeat_fire';
--> statement-breakpoint
UPDATE "public"."traces" t
   SET "login_id" = coalesce(r."login_id", r."owner_id")
  FROM "public"."run_items" i
  JOIN "public"."runs" r ON r."id" = i."run_id"
 WHERE t."login_id" IS NULL AND t."subject_kind" = 'run_item'
   AND t."subject_id" = i."id" AND r."owner_id" = t."owner_id";
--> statement-breakpoint
UPDATE "public"."traces" t
   SET "login_id" = coalesce(r."login_id", r."owner_id")
  FROM "public"."runs" r
 WHERE t."login_id" IS NULL AND t."subject_kind" = 'run'
   AND t."subject_id" = r."id" AND r."owner_id" = t."owner_id";
--> statement-breakpoint
UPDATE "public"."traces" t
   SET "login_id" = own."login"
  FROM (SELECT n."id", n."owner_id", coalesce(n."login_id", p."login_id") AS "login"
          FROM "public"."nodes" n
          LEFT JOIN "public"."item_grants" g ON g."node_id" = n."id" AND g."is_home"
          LEFT JOIN "public"."private_workspaces" p ON p."workspace_id" = g."workspace_id"
         WHERE coalesce(n."login_id", p."login_id") IS NOT NULL) own
 WHERE t."login_id" IS NULL AND t."subject_kind" = 'node'
   AND t."subject_id" = own."id" AND t."owner_id" = own."owner_id";
--> statement-breakpoint
UPDATE "public"."traces" c
   SET "login_id" = p."login_id"
  FROM "public"."traces" p
 WHERE c."login_id" IS NULL
   AND c."data" ->> 'parent_trace_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND p."id" = (c."data" ->> 'parent_trace_id')::uuid
   AND p."owner_id" = c."owner_id" AND p."login_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "public"."traces" c
   SET "login_id" = p."login_id"
  FROM "public"."traces" p
 WHERE c."login_id" IS NULL
   AND c."data" ->> 'parent_trace_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND p."id" = (c."data" ->> 'parent_trace_id')::uuid
   AND p."owner_id" = c."owner_id" AND p."login_id" IS NOT NULL;
