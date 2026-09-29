-- Client logins audit fixes (2026-09-29), the client level. Forward only,
-- idempotent: every statement drops or checks first, so a hand re-run is
-- safe.
--
--  1. (A5) The client role reads agents and tool groups at CLIENT level
--     only. Since decision 3 client and public are siblings, not a chain
--     (the client role reads client items only), and the code refuses a
--     client scope meeting public work (ViewerLevelConflictError). The team
--     and public roles keep every row (team delegation to admin agents).
--  2. (A27) mantle_brain_id() is SECURITY DEFINER (0187), so its EXECUTE is
--     no longer open to every role: only the viewer roles and the space role
--     (their row rules and resolveSingleOwnerId call it) and, where it
--     exists, the demo branch's read-only role. The app itself connects as
--     the Postgres superuser, which needs no grant.
--  3. (A27) tool_results.viewer_level: the level a spilled tool result was
--     written at (null = admin). read_result refuses a spill above the
--     reader's level. A new nullable column: metadata only, no rewrite.
--  4. (A17) A client's personal item never becomes a team draft: a trigger
--     refuses sharing = 'team' on a client's item (decision 5: client
--     drafts stay private until submitted). Members are untouched: the
--     trigger only looks when the new value is 'team', and only refuses a
--     client's item.
--  5. (A23) A small partial index for the "What clients see" email hints:
--     the report reads only email_page steps of the last 400 days.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- ── 1. Agents and tool groups: client level only ────────────────────────────
DROP POLICY IF EXISTS "agents_client_read" ON "public"."agents";
--> statement-breakpoint
CREATE POLICY "agents_client_read" ON "public"."agents" FOR SELECT
  TO mantle_view_client
  USING ("audience" = 'client');
--> statement-breakpoint
DROP POLICY IF EXISTS "tool_groups_client_read" ON "public"."tool_groups";
--> statement-breakpoint
CREATE POLICY "tool_groups_client_read" ON "public"."tool_groups" FOR SELECT
  TO mantle_view_client
  USING ("audience" = 'client');
--> statement-breakpoint

-- ── 2. mantle_brain_id(): EXECUTE for the roles that call it ────────────────
REVOKE EXECUTE ON FUNCTION "public"."mantle_brain_id"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_brain_id"()
  TO mantle_view_team, mantle_view_client, mantle_view_public, mantle_view_space;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_brain_id"() TO demo_reader;
  END IF;
END
$$;
--> statement-breakpoint

-- ── 3. The level a spilled tool result was written at ───────────────────────
ALTER TABLE "public"."tool_results" ADD COLUMN IF NOT EXISTS "viewer_level" text;
--> statement-breakpoint

-- ── 4. A client's items stay private until submitted ────────────────────────
CREATE OR REPLACE FUNCTION "public"."mantle_space_item_client_private"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users u
              WHERE u.id = NEW.author_login_id AND u.role = 'client')
     OR EXISTS (SELECT 1 FROM public.nodes n
                  JOIN public.spaces s ON s.id = n.owner_id AND s.kind = 'personal'
                  JOIN auth.users u ON u.id = s.login_id
                 WHERE n.id = NEW.node_id AND u.role = 'client') THEN
    RAISE EXCEPTION 'A client''s item cannot be shared with the team'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_space_item_client_private"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "space_items_client_private" ON "public"."space_items";
--> statement-breakpoint
CREATE TRIGGER "space_items_client_private"
  BEFORE INSERT OR UPDATE OF "sharing" ON "public"."space_items"
  FOR EACH ROW WHEN (NEW."sharing" = 'team')
  EXECUTE FUNCTION "public"."mantle_space_item_client_private"();
--> statement-breakpoint
-- Nothing could share a client's item before this (no client route does),
-- but make it true for every row.
UPDATE "public"."space_items" si SET "sharing" = 'private'
 WHERE si."sharing" = 'team'
   AND EXISTS (SELECT 1 FROM "auth"."users" u
                WHERE u.id = si."author_login_id" AND u.role = 'client');
--> statement-breakpoint

-- ── 5. The email hints' steps ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "trace_steps_email_page_idx"
  ON "public"."trace_steps" ("created_at")
  WHERE "name" = 'tool: email_page';
