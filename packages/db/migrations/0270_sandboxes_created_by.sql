-- Workspaces W7a fix rounds 2 to 5 and the W7 integration fix 2: the login
-- that made a sandbox, a heartbeat and an API tool, that configured a tool
-- group, an agent, an AI worker and the embedding config, and that a
-- heartbeat fire answered.
--
-- Re-runnable: every column is added only when missing.
--
-- Numbered 0270 (W7 integration fix 2; built as 0271): migrate.ts skips a
-- migration whose journal `when` is at or below the highest one applied, so
-- this one takes the slot right after 0269. Its `when` sits above
-- 1790195340000, the `when` the round-1 0271 carried: a database that
-- applied that 0271 still applies this one (every step here is
-- re-runnable). W7 integration fix 4 raised it again, from 1790195400000 to
-- 1790195460000, when 0269's repair of a folded team row moved here (the
-- last statement): a database that already applied this migration at
-- 1790195400000 applies it once more and gets the repair. W7d's next
-- migration takes 0271 or later with a `when` higher than 1790195460000.
--
-- Any Admin user whose settings area is on may use the sandbox tools, and a
-- sandbox may mount a Files folder read-only (sandbox_create's inbox). So a
-- second Admin login could run commands in, or read files out of, a sandbox
-- the brain owner made, folder mount included. A sandbox now records the
-- login that made it: in a workspace scope the sandbox tools work only on
-- the caller's own sandboxes, and the brain owner (the anchor login) on
-- every one. A row made before this column has none, and counts as the
-- brain owner's. Only the brain owner mounts a folder.
--
-- A heartbeat (fix round 3) records the login that set up what it does (its
-- agent, skill, schedule, surface or state), when that is not the brain
-- owner: the tick fires it in that login's scope, so a second Admin login's
-- heartbeat never fires as the brain owner. Null: the brain owner's.
--
-- An API tool (fix round 3) records the login that wrote its templates,
-- when that is not the brain owner: at run time its {{secret:...}} and
-- {{oauth:...}} refs resolve only while that login holds the keys area.
-- Null: the brain owner's (and every tool a sync or the system made).
--
-- A tool group (fix round 4) records the login that last paired its
-- integration's vault key with its host (a base URL, an MCP connector's URL,
-- an OAuth2 token URL), when that is not the brain owner: the tools an
-- OpenAPI connector's sync writes and the tools authored into the group take
-- it as their maker, and an MCP connector's key resolves only while that
-- login holds the keys area. Null: the brain owner's.
--
-- An agent, an AI worker and the embedding config (fix round 5) record the
-- login that last paired a model route's vault key (its key id, or the
-- provider's own key it falls back to) with a base URL of its choosing,
-- when that is not the brain owner: a route with a base URL resolves its key
-- only while that login holds the keys area. Null: the brain owner's.
--
-- A heartbeat fire (W7 integration fix 2) records the login it answered;
-- see its ALTER below.
--
-- No foreign keys: a login that is gone leaves its rows to the rules above
-- (a sandbox to the brain owner; a heartbeat pauses; a tool's or a
-- connector's secrets stop resolving).
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- Every table this migration alters in one statement with a short wait and a
-- retry, like 0269: waiting on one while holding the others would stall
-- every reader.
DO $$
DECLARE
  attempt int := 0;
BEGIN
  LOOP
    attempt := attempt + 1;
    BEGIN
      LOCK TABLE "public"."sandboxes", "public"."heartbeats", "public"."tools",
                 "public"."tool_groups", "public"."agents", "public"."ai_workers",
                 "public"."embedding_config", "public"."heartbeat_fires"
        IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt >= 20 THEN
        RAISE EXCEPTION '0270: the tables stayed busy for 20 attempts; run the migration again at a quieter time'
          USING ERRCODE = 'lock_not_available';
      END IF;
      RAISE NOTICE '0270: tables busy (attempt %), retrying', attempt;
      PERFORM pg_sleep(least(attempt, 5));
    END;
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS created_by uuid;
--> statement-breakpoint
ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS created_by uuid;
--> statement-breakpoint
ALTER TABLE tools ADD COLUMN IF NOT EXISTS created_by uuid;
--> statement-breakpoint
ALTER TABLE tool_groups ADD COLUMN IF NOT EXISTS configured_by uuid;
--> statement-breakpoint
ALTER TABLE agents ADD COLUMN IF NOT EXISTS configured_by uuid;
--> statement-breakpoint
ALTER TABLE ai_workers ADD COLUMN IF NOT EXISTS configured_by uuid;
--> statement-breakpoint
ALTER TABLE embedding_config ADD COLUMN IF NOT EXISTS configured_by uuid;
--> statement-breakpoint
-- A heartbeat fire (W7 integration fix 2) records the login it answered:
-- the firer for Fire now and heartbeat_fire, the maker (created_by) for the
-- tick. Only that login reads the fire's reply, its state before and after
-- and its trace. Null: the brain owner (and every fire made before this
-- column).
ALTER TABLE heartbeat_fires ADD COLUMN IF NOT EXISTS answered_by uuid;
--> statement-breakpoint
-- 0269's repair of a folded team row (W7 integration fix 4; it was 0269's
-- in fix 3, L6, where a database that already ran 0269 never met it): a row
-- an earlier build of 0269 folded with no workspace, whether its agent is
-- gone or still there, takes what 0269's insert gives a row now: the Team
-- workspace's assistant (else its own agent) and the Team workspace (else
-- its agent's, else the Team bridge workspace). A row still left with none
-- stays as it is. Re-runnable: a repaired row has a workspace, so a second
-- run touches nothing. An UPDATE that leaves the status as it is: neither
-- conversation notify fires.
UPDATE "public"."assistant_messages" m
   SET "agent_id" = coalesce(fix."agent_id", m."agent_id"),
       "workspace_id" = fix."ws_id"
  FROM (
    SELECT m2."id",
           team."agent_id",
           coalesce(team."ws_id",
                    (SELECT a."workspace_id" FROM "public"."agents" a WHERE a."id" = m2."agent_id"),
                    (SELECT w."id" FROM "public"."workspaces" w
                      WHERE w."owner_id" = m2."owner_id" AND w."bridge_key" = 'team'
                      ORDER BY w."archived_at" NULLS FIRST LIMIT 1)) AS ws_id
      FROM "public"."assistant_messages" m2
      LEFT JOIN LATERAL (
        SELECT w."id" AS ws_id, a."id" AS agent_id
          FROM "public"."workspaces" w
          JOIN "public"."workspace_resources" r
            ON r."workspace_id" = w."id" AND r."type" = 'assistant'
          JOIN "public"."agents" a ON a."id"::text = r."ref_id" AND a."owner_id" = m2."owner_id"
         WHERE w."owner_id" = m2."owner_id" AND w."bridge_key" = 'team'
         ORDER BY w."archived_at" NULLS FIRST, a."enabled" DESC
         LIMIT 1
      ) team ON true
     WHERE m2."data" ->> 'folded_from' = 'team_messages'
       AND m2."workspace_id" IS NULL
  ) fix
 WHERE m."id" = fix."id"
   AND fix."ws_id" IS NOT NULL;
