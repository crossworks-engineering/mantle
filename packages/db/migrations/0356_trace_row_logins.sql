-- Every trace row names the login whose work it is (traces.login_id), so
-- the activity lists (the Activity column, the journey feed, /traces) show
-- each Admin user the system's work and its own, never another login's.
--
-- From this release every writer stamps the row (packages/tracing
-- rowLoginFor). Rows stored before it with no login are stamped here, once,
-- from what they already name, in this order:
--   1. a heartbeat fire: the login its fire answered (heartbeat_fires), the
--      anchor's (owner_id) when it answered none or has no fire row;
--   2. a run's trace (a run item's, or a resumed run's turn): the run's
--      login, the anchor's when the run names none;
--   3. a trace over a chat thread, a pending tool call or an assistant
--      message: that row's login; over a Telegram message: its chat's
--      login (the Telegram tables carry no owner: one brain per database);
--   4. a row whose data names a login (data.login_id, written before the
--      0269 stamp trigger read it);
--   5. a trace over a node: a per-login row's login (nodes.login_id), the
--      login whose private workspace is its home, and for an item homed in
--      any other workspace than Admin, the login whose ingest made it while
--      it is still a user there, else no one (the nil uuid, which no login
--      has: no reader, the anchor included, lists it); over a node that is
--      gone, no one too;
--   6. a delegated child (data.parent_trace_id): its parent's login, else
--      its grandparent's;
--   7. last, what none of these classified, among the kinds that carry a
--      login's content (content_ingest, photo_ingest, extractor_run,
--      summarizer_run, reflector_run, manual: the simulated MCP turn, the
--      turn input and an approved call; responder_turn, run_item): no one.
--      Whose work it was cannot be told, so it is listed to no one, the
--      anchor included. The rows stay in the database; only the activity
--      lists stop showing them. A trace over a node homed in Admin (or in no
--      workspace) that names no login is the system's and stays so; so does
--      a federation_request.
-- No one (the nil uuid) is the stamp of work whose login cannot be told:
-- under the rule that activity is its user's, it is never handed to the
-- anchor or listed to the Admin users as the system's.
-- Every step changes only rows with no login, and only from a row of the
-- same owner, so no stamped row is touched and a re-run changes nothing.
--
-- Cost: one transaction (the runner applies each migration in its own), so
-- it cannot commit in batches. Steps 1 to 3 and 5 are joins on indexed keys;
-- steps 4 and 6 read every row with no login once each (the JSON is read
-- once per row, in a subquery). On a box with millions of traces it may
-- take minutes at boot. It locks only the rows it updates; each statement
-- waits at most 30 s for a lock (lock_timeout), and on a timeout the
-- migration rolls back and the roll can simply be run again.
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
   SET "login_id" = c."login_id"
  FROM "public"."chat_threads" c
 WHERE t."login_id" IS NULL AND t."subject_kind" = 'chat_thread'
   AND t."subject_id" = c."id" AND c."owner_id" = t."owner_id"
   AND c."login_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "public"."traces" t
   SET "login_id" = p."login_id"
  FROM "public"."pending_tool_calls" p
 WHERE t."login_id" IS NULL AND t."subject_kind" = 'pending_tool_call'
   AND t."subject_id" = p."id" AND p."owner_id" = t."owner_id"
   AND p."login_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "public"."traces" t
   SET "login_id" = a."login_id"
  FROM "public"."assistant_messages" a
 WHERE t."login_id" IS NULL AND t."subject_kind" = 'assistant_message'
   AND t."subject_id" = a."id" AND a."owner_id" = t."owner_id"
   AND a."login_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "public"."traces" t
   SET "login_id" = c."login_id"
  FROM "public"."telegram_messages" m
  JOIN "public"."telegram_chats" c ON c."id" = m."chat_id"
 WHERE t."login_id" IS NULL AND t."subject_kind" = 'telegram_message'
   AND t."subject_id" = m."id" AND c."login_id" IS NOT NULL
   AND EXISTS (SELECT 1 FROM "auth"."users" u WHERE u."id" = c."login_id");
--> statement-breakpoint
UPDATE "public"."traces" t
   SET "login_id" = k."login"
  FROM (SELECT s."id",
               CASE WHEN s."data" ->> 'login_id'
                         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN (s."data" ->> 'login_id')::uuid END AS "login"
          FROM "public"."traces" s
         WHERE s."login_id" IS NULL) k
 WHERE t."id" = k."id" AND t."login_id" IS NULL AND k."login" IS NOT NULL
   AND EXISTS (SELECT 1 FROM "auth"."users" u WHERE u."id" = k."login");
--> statement-breakpoint
UPDATE "public"."traces" t
   SET "login_id" = own."login"
  FROM (SELECT n."id", n."owner_id",
               coalesce(
                 n."login_id",
                 p."login_id",
                 CASE WHEN NOT w."is_admin" THEN coalesce(
                   (SELECT i."login_id" FROM "public"."traces" i
                     WHERE i."subject_kind" = 'node' AND i."subject_id" = n."id"
                       AND i."owner_id" = n."owner_id" AND i."kind" = 'content_ingest'
                       AND i."login_id" IS NOT NULL
                       AND i."login_id" <> '00000000-0000-0000-0000-000000000000'::uuid
                       AND EXISTS (SELECT 1 FROM "public"."workspace_users" wu
                                    WHERE wu."workspace_id" = w."id"
                                      AND wu."login_id" = i."login_id")
                     ORDER BY i."started_at" LIMIT 1),
                   '00000000-0000-0000-0000-000000000000'::uuid)
                 END) AS "login"
          FROM "public"."nodes" n
          LEFT JOIN "public"."item_grants" g ON g."node_id" = n."id" AND g."is_home"
          LEFT JOIN "public"."private_workspaces" p ON p."workspace_id" = g."workspace_id"
          LEFT JOIN "public"."workspaces" w ON w."id" = g."workspace_id"
         WHERE n."id" IN (SELECT s."subject_id" FROM "public"."traces" s
                           WHERE s."login_id" IS NULL AND s."subject_kind" = 'node')) own
 WHERE t."login_id" IS NULL AND t."subject_kind" = 'node'
   AND t."subject_id" = own."id" AND t."owner_id" = own."owner_id"
   AND own."login" IS NOT NULL;
--> statement-breakpoint
UPDATE "public"."traces" c
   SET "login_id" = coalesce(p."login_id", gp."login_id")
  FROM (SELECT s."id", s."owner_id",
               CASE WHEN s."data" ->> 'parent_trace_id'
                         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN (s."data" ->> 'parent_trace_id')::uuid END AS "parent"
          FROM "public"."traces" s
         WHERE s."login_id" IS NULL) k
  JOIN "public"."traces" p ON p."id" = k."parent" AND p."owner_id" = k."owner_id"
  LEFT JOIN "public"."traces" gp
    ON p."login_id" IS NULL AND gp."owner_id" = p."owner_id"
   AND gp."id" = CASE WHEN p."data" ->> 'parent_trace_id'
                           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      THEN (p."data" ->> 'parent_trace_id')::uuid END
 WHERE c."id" = k."id" AND c."login_id" IS NULL
   AND coalesce(p."login_id", gp."login_id") IS NOT NULL;
--> statement-breakpoint
UPDATE "public"."traces" t
   SET "login_id" = '00000000-0000-0000-0000-000000000000'::uuid
 WHERE t."login_id" IS NULL AND t."subject_kind" = 'node'
   AND NOT EXISTS (SELECT 1 FROM "public"."nodes" n
                    WHERE n."id" = t."subject_id" AND n."owner_id" = t."owner_id");
--> statement-breakpoint
UPDATE "public"."traces" t
   SET "login_id" = '00000000-0000-0000-0000-000000000000'::uuid
 WHERE t."login_id" IS NULL
   AND t."kind" IN ('content_ingest', 'photo_ingest', 'extractor_run', 'summarizer_run',
                    'reflector_run', 'manual', 'responder_turn', 'run_item')
   AND NOT (coalesce(t."subject_kind" = 'node', false) AND EXISTS (
         SELECT 1 FROM "public"."nodes" n
           LEFT JOIN "public"."item_grants" g ON g."node_id" = n."id" AND g."is_home"
           LEFT JOIN "public"."workspaces" w ON w."id" = g."workspace_id"
          WHERE n."id" = t."subject_id" AND n."owner_id" = t."owner_id"
            AND n."login_id" IS NULL AND (w."id" IS NULL OR w."is_admin")));
