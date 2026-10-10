-- Workspaces, the W5b1 audit's Low items, done in W5b2 (plan page 4887b8e7).
--
-- L1: mantle_ws_attach_assistants (0259) put a default assistant back on a
-- workspace whose Moderator had taken it off: the removal clears
-- agents.workspace_id, and every boot and every agent level change attached
-- it again. A workspace whose assistant was ever removed by hand (a
-- resource.remove event for kind assistant) is now left as its Moderator
-- left it.
-- Nits: the Team pick needs the agent enabled, as the Admin pick does; and
-- every attach writes a resource.add event (actor NULL, subject.by =
-- 'attach'), so the workspace screen's history says how it got there.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_attach_assistants"()
  RETURNS integer LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp
  SET lock_timeout = '10s' AS $$
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  admin_ws uuid;
  team_ws uuid;
  pick uuid;
  added integer := 0;
BEGIN
  IF brain IS NULL THEN RETURN 0; END IF;
  SELECT w."id" INTO admin_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = brain AND w."bridge_key" = 'admin';
  SELECT w."id" INTO team_ws FROM "public"."workspaces" w
   WHERE w."owner_id" = brain AND w."bridge_key" = 'team';
  IF admin_ws IS NULL THEN RETURN 0; END IF;
  -- The persona on Admin: the selection of 0251 (the enabled admin-level
  -- responder, highest priority, a shared one before a login's own).
  IF NOT EXISTS (SELECT 1 FROM "public"."workspace_resources" r
                  WHERE r."workspace_id" = admin_ws AND r."type" = 'assistant')
     AND NOT EXISTS (SELECT 1 FROM "public"."workspace_events" e
                      WHERE e."workspace_id" = admin_ws AND e."action" = 'resource.remove'
                        AND e."subject" ->> 'kind' = 'assistant') THEN
    SELECT a."id" INTO pick FROM "public"."agents" a
     WHERE a."owner_id" = brain AND a."role" = 'responder' AND a."audience" = 'admin' AND a."enabled"
       AND a."workspace_id" IS NULL
     ORDER BY a."priority" DESC, a."assigned_user_id" IS NOT NULL, a."created_at"
     LIMIT 1;
    IF pick IS NOT NULL THEN
      INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
      VALUES (admin_ws, 'assistant', pick::text, true);
      INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
      VALUES (admin_ws, NULL, 'resource.add',
              jsonb_build_object('kind', 'assistant', 'id', pick, 'by', 'attach'));
      added := added + 1;
    END IF;
  END IF;
  -- The team responder on Team.
  IF team_ws IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "public"."workspace_resources" r
                      WHERE r."workspace_id" = team_ws AND r."type" = 'assistant')
     AND NOT EXISTS (SELECT 1 FROM "public"."workspace_events" e
                      WHERE e."workspace_id" = team_ws AND e."action" = 'resource.remove'
                        AND e."subject" ->> 'kind' = 'assistant') THEN
    pick := NULL;
    SELECT a."id" INTO pick FROM "public"."agents" a
     WHERE a."owner_id" = brain AND a."slug" = 'team-responder' AND a."audience" = 'team'
       AND a."enabled" AND a."workspace_id" IS NULL
     LIMIT 1;
    IF pick IS NOT NULL THEN
      INSERT INTO "public"."workspace_resources" ("workspace_id", "type", "ref_id", "write")
      VALUES (team_ws, 'assistant', pick::text, true);
      INSERT INTO "public"."workspace_events" ("workspace_id", "actor_id", "action", "subject")
      VALUES (team_ws, NULL, 'resource.add',
              jsonb_build_object('kind', 'assistant', 'id', pick, 'by', 'attach'));
      added := added + 1;
    END IF;
  END IF;
  RETURN added;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_attach_assistants"() FROM PUBLIC;
