-- Two definers for the writes of an Admin area's narrow exit that ran at a
-- full-route spot (plan v3.2 S7b part b2; packages/db viewer.ts
-- FULL_ROUTE_SPOTS promotion-space and agent-conversation): the narrow role
-- runs these functions and holds no right on the content tables they write.
-- Each does what the app's own statements did on the system pool, so every
-- answer is the same (narrow-spots.db.test.ts holds the two equal).
--
-- The caller of each, as mantle_structure_item's (0315): no scope (a
-- scope's own writes go through the write role), a system session
-- (mantle_system_session: the runtime role, the narrow role, a superuser
-- or the definers' owner, 0314's rule; on the narrow login the acting
-- login is a mistake guard, 0314's header), LOGIN equal to the acting login the gateway sends
-- (mantle.acting_login; none, or another, is refused), that login holding
-- the function's area (mantle_area_rule), not read-only (mantle.write_mode
-- ro). Refused: 42501.
--
--  - mantle_space_settle_promotion(login, target), the users area: a login
--    made admin (TARGET's role is admin when it runs: the role change's own
--    transaction ran its update first) gets the items of its personal space
--    it shared with the team or submitted for review back as private
--    drafts, and the recorded bundles of those items go (packages/content
--    member-space-login.ts settleSpaceOnPromotion). Returns how many items.
--    A target that is no admin is refused.
--  - mantle_agent_delete(login, owner, agent, conversation), the assistants
--    area: an assistant deleted (server/web lib/agents.ts deleteAgent). The
--    heads of the digests that go with its conversation and of their
--    folders, for update (as withNodeDeleteHeads); the agent row locked;
--    with CONVERSATION its assistant_messages rows and its digests (the
--    conversation-digest notes and the chat archive summaries whose
--    data.agent_id is the agent) deleted; a Telegram chat pinned to it
--    denied; the agent row deleted (its foreign keys cascade or set null as
--    before). OWNER must be this brain. Returns one row: whether the agent
--    was there, and how many messages and digests went.
--
-- EXECUTE: taken from PUBLIC here; migrate gives both to the runtime role
-- (runtime-role.ts RUNTIME_SYSTEM_FUNCTIONS) and the narrow role
-- (NARROW_SYSTEM_FUNCTIONS). The write role and the user role hold none.
-- No table, row or trigger changes; no LLM work. Re-runnable. Revert:
-- packages/db/rollback/0316_promotion_agent_definers.revert.sql (not needed
-- for a one-image rollback: the image before this one never calls them).
-- The `when` sits 60000 above 0315's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_space_settle_promotion"(login uuid, target uuid)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  ids uuid[];
BEGIN
  IF coalesce(current_setting('mantle.write_mode', true), '') = 'ro' THEN
    RAISE EXCEPTION 'mantle_space_settle_promotion: a read-only caller' USING ERRCODE = '42501';
  ELSIF "public"."mantle_scope_active"() OR "public"."mantle_scope_login_id"() IS NOT NULL THEN
    RAISE EXCEPTION 'mantle_space_settle_promotion: only with no scope' USING ERRCODE = '42501';
  ELSIF NOT "public"."mantle_system_session"() THEN
    RAISE EXCEPTION 'mantle_space_settle_promotion: not a system session' USING ERRCODE = '42501';
  ELSIF "mantle_space_settle_promotion"."login" IS NULL
     OR "mantle_space_settle_promotion"."login" IS DISTINCT FROM
        nullif(current_setting('mantle.acting_login', true), '')::uuid THEN
    RAISE EXCEPTION 'mantle_space_settle_promotion: only the acting login' USING ERRCODE = '42501';
  ELSIF NOT "public"."mantle_area_rule"("mantle_space_settle_promotion"."login", 'users') THEN
    RAISE EXCEPTION 'mantle_space_settle_promotion: the acting login does not hold the area' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "auth"."users" u
                  WHERE u."id" = "mantle_space_settle_promotion"."target" AND u."role" = 'admin') THEN
    RAISE EXCEPTION 'mantle_space_settle_promotion: the login is no admin' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(array_agg(si."node_id"), '{}'::uuid[]) INTO ids FROM (
    SELECT si."node_id" FROM "public"."space_items" si
      JOIN "public"."nodes" n ON n."id" = si."node_id"
      JOIN "public"."spaces" s ON s."id" = n."owner_id"
     WHERE s."kind" = 'personal' AND s."login_id" = "mantle_space_settle_promotion"."target"
       AND (si."sharing" = 'team' OR si."review_state" = 'submitted')
       FOR UPDATE OF si
  ) si;
  IF cardinality(ids) = 0 THEN RETURN 0; END IF;
  UPDATE "public"."space_items" SET "sharing" = 'private', "updated_at" = now()
   WHERE "node_id" = ANY (ids) AND "sharing" = 'team';
  UPDATE "public"."space_items"
     SET "review_state" = 'draft', "submitted_at" = NULL, "updated_at" = now()
   WHERE "node_id" = ANY (ids) AND "review_state" = 'submitted';
  DELETE FROM "public"."space_item_bundles" WHERE "root_id" = ANY (ids);
  RETURN cardinality(ids);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_space_settle_promotion"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_agent_delete"(
  login uuid, owner uuid, agent uuid, conversation boolean)
  RETURNS TABLE(found boolean, messages integer, digests integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  digest_ids uuid[] := '{}'::uuid[];
  heads uuid[];
  n_msgs integer := 0;
  n_digests integer := 0;
BEGIN
  IF coalesce(current_setting('mantle.write_mode', true), '') = 'ro' THEN
    RAISE EXCEPTION 'mantle_agent_delete: a read-only caller' USING ERRCODE = '42501';
  ELSIF "public"."mantle_scope_active"() OR "public"."mantle_scope_login_id"() IS NOT NULL THEN
    RAISE EXCEPTION 'mantle_agent_delete: only with no scope' USING ERRCODE = '42501';
  ELSIF NOT "public"."mantle_system_session"() THEN
    RAISE EXCEPTION 'mantle_agent_delete: not a system session' USING ERRCODE = '42501';
  ELSIF "mantle_agent_delete"."login" IS NULL
     OR "mantle_agent_delete"."login" IS DISTINCT FROM
        nullif(current_setting('mantle.acting_login', true), '')::uuid THEN
    RAISE EXCEPTION 'mantle_agent_delete: only the acting login' USING ERRCODE = '42501';
  ELSIF NOT "public"."mantle_area_rule"("mantle_agent_delete"."login", 'assistants') THEN
    RAISE EXCEPTION 'mantle_agent_delete: the acting login does not hold the area' USING ERRCODE = '42501';
  END IF;
  IF "mantle_agent_delete"."owner" IS DISTINCT FROM "public"."mantle_brain_id"() THEN
    RAISE EXCEPTION 'mantle_agent_delete: only on this brain' USING ERRCODE = '42501';
  END IF;
  -- The digests (deleteAgent's digestWhere): read first, so their heads
  -- are the transaction's first lock.
  IF "mantle_agent_delete"."conversation" THEN
    SELECT coalesce(array_agg(n."id"), '{}'::uuid[]) INTO digest_ids FROM "public"."nodes" n
     WHERE n."owner_id" = "mantle_agent_delete"."owner" AND n."type" = 'note'
       AND (n."tags" @> ARRAY['conversation-digest']::text[] OR n."data" ->> 'kind' = 'chat_archive')
       AND n."data" ->> 'agent_id' = "mantle_agent_delete"."agent"::text;
  END IF;
  SELECT coalesce(array_agg(DISTINCT x."id"), '{}'::uuid[]) INTO heads FROM (
    SELECT d."id" FROM "public"."nodes" n
      JOIN "public"."nodes" d ON d."owner_id" = n."owner_id"
       AND (d."id" = n."id" OR (n."type" = 'branch' AND d."path" <@ n."path"))
     WHERE n."id" = ANY (digest_ids)
    UNION
    SELECT "public"."mantle_parent_folder"(n."owner_id", n."type", n."path") FROM "public"."nodes" n
     WHERE n."id" = ANY (digest_ids)
  ) x WHERE x."id" IS NOT NULL;
  PERFORM "public"."mantle_lock_heads_nested"(heads, 'update');
  PERFORM 1 FROM "public"."agents" a
    WHERE a."id" = "mantle_agent_delete"."agent" AND a."owner_id" = "mantle_agent_delete"."owner"
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, 0;
    RETURN;
  END IF;
  IF "mantle_agent_delete"."conversation" THEN
    WITH d AS (
      DELETE FROM "public"."assistant_messages" m
       WHERE m."owner_id" = "mantle_agent_delete"."owner" AND m."agent_id" = "mantle_agent_delete"."agent"
      RETURNING 1)
    SELECT count(*)::integer INTO n_msgs FROM d;
    WITH d AS (
      DELETE FROM "public"."nodes" n
       WHERE n."owner_id" = "mantle_agent_delete"."owner" AND n."type" = 'note'
         AND (n."tags" @> ARRAY['conversation-digest']::text[] OR n."data" ->> 'kind' = 'chat_archive')
         AND n."data" ->> 'agent_id' = "mantle_agent_delete"."agent"::text
      RETURNING 1)
    SELECT count(*)::integer INTO n_digests FROM d;
  END IF;
  UPDATE "public"."telegram_chats" SET "allowlist_status" = 'denied', "updated_at" = now()
   WHERE "responder_agent_id" = "mantle_agent_delete"."agent"
     AND "user_id" = "mantle_agent_delete"."owner";
  DELETE FROM "public"."agents" a
   WHERE a."id" = "mantle_agent_delete"."agent" AND a."owner_id" = "mantle_agent_delete"."owner";
  RETURN QUERY SELECT true, n_msgs, n_digests;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_agent_delete"(uuid, uuid, uuid, boolean) FROM PUBLIC;
