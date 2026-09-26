-- Member logins, Phase 2: personal spaces (plan v3.1 sections 2, 2b, 2d, 9).
--
-- nodes.owner_id stops meaning "a login" and starts meaning "a space": the
-- brain (one row whose id is the anchor login's id, so no existing row
-- changes) or a login's personal space. Every brain path already filters on
-- the brain id, so a personal item is invisible to the brain from the first
-- row: no extraction (trigger skip below + the gate's owner check), no Recall,
-- no search.
--
-- This migration takes short locks only: the foreign key is added NOT VALID
-- here and VALIDATEd in 0166, in its own transaction.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."spaces" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"       text NOT NULL CHECK ("kind" IN ('brain', 'personal')),
  -- The login the space belongs to. A hard-deleted login leaves its space
  -- (and its items) behind with no login: nothing cascades (plan 6.4).
  "login_id"   uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One personal space per login.
CREATE UNIQUE INDEX IF NOT EXISTS "spaces_personal_login_uq"
  ON "public"."spaces" ("login_id") WHERE "kind" = 'personal';
--> statement-breakpoint

-- The brain rows: the anchor, plus any login that already owns rows (a
-- pre-0111 box, or a test database's own owners). Id = the login id, so
-- every existing nodes.owner_id keeps pointing at the same value.
INSERT INTO "public"."spaces" ("id", "kind", "login_id")
  SELECT u.id, 'brain', u.id FROM "auth"."users" u
   WHERE u.is_owner OR EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.owner_id = u.id)
  ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- A personal space for every login, admins included (plan 1: every login).
INSERT INTO "public"."spaces" ("kind", "login_id")
  SELECT 'personal', u.id FROM "auth"."users" u
  ON CONFLICT ("login_id") WHERE "kind" = 'personal' DO NOTHING;
--> statement-breakpoint

-- New logins get their spaces with the row: a personal space always, the
-- brain row when the login is the anchor.
CREATE OR REPLACE FUNCTION "public"."mantle_login_spaces"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "public"."spaces" ("kind", "login_id") VALUES ('personal', NEW.id)
    ON CONFLICT ("login_id") WHERE "kind" = 'personal' DO NOTHING;
  IF NEW.is_owner THEN
    INSERT INTO "public"."spaces" ("id", "kind", "login_id") VALUES (NEW.id, 'brain', NEW.id)
      ON CONFLICT ("id") DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_spaces_trg" ON "auth"."users";
--> statement-breakpoint
CREATE TRIGGER "users_spaces_trg"
  AFTER INSERT OR UPDATE OF "is_owner" ON "auth"."users"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_login_spaces"();
--> statement-breakpoint

-- ── The foreign key moves: nodes.owner_id -> spaces ─────────────────────────
-- Whatever the old constraint is called on this box, drop the one that points
-- at auth.users. Deleting a space deletes its items (the purge path); deleting
-- a login no longer deletes anything.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.nodes'::regclass AND contype = 'f'
       AND confrelid = 'auth.users'::regclass
  LOOP
    EXECUTE format('ALTER TABLE "public"."nodes" DROP CONSTRAINT %I', c);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE "public"."nodes"
  ADD CONSTRAINT "nodes_owner_space_fk" FOREIGN KEY ("owner_id")
  REFERENCES "public"."spaces"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

-- Whether an owner id is a brain space. Personal items are never announced to
-- the extractor and never reaped for facts or graph edges (they have none).
-- SECURITY DEFINER: the triggers below run as whoever writes the node (the
-- space role for a member), which holds no privilege on spaces; the function
-- answers one yes/no and reads nothing else.
CREATE OR REPLACE FUNCTION "public"."mantle_is_brain_space"(owner uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM "public"."spaces" s WHERE s.id = owner AND s.kind = 'brain')
$$;
--> statement-breakpoint

-- The personal space the current transaction acts for: set by the member
-- request (or a my-space tool) with set_config('mantle.space_id', id, true).
-- Unset = no space: every personal-space rule matches nothing.
CREATE OR REPLACE FUNCTION "public"."mantle_space_id"()
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('mantle.space_id', true), '')::uuid
$$;
--> statement-breakpoint

-- ── Personal items: sharing and review state (plan 2d) ─────────────────────
CREATE TABLE IF NOT EXISTS "public"."space_items" (
  "node_id"           uuid PRIMARY KEY REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  -- Who wrote it. Survives accept. Null only after a hard login delete.
  "author_login_id"   uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "sharing"           text NOT NULL DEFAULT 'private' CHECK ("sharing" IN ('private', 'team')),
  "review_state"      text NOT NULL DEFAULT 'draft'
                        CHECK ("review_state" IN ('draft', 'submitted', 'returned', 'accepted')),
  "submitted_at"      timestamptz,
  "submitted_version" integer,
  "returned_note"     text,
  "reviewed_by"       uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "reviewed_at"       timestamptz,
  "accepted_at"       timestamptz,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_items_team_idx"
  ON "public"."space_items" ("node_id") WHERE "sharing" = 'team';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_items_submitted_idx"
  ON "public"."space_items" ("submitted_at") WHERE "review_state" = 'submitted';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_items_author_idx"
  ON "public"."space_items" ("author_login_id");
--> statement-breakpoint

-- ── Triggers learn about spaces ─────────────────────────────────────────────
-- The extractor is never told about a personal item (plan 2, blocker 1). The
-- gate's owner check stays the lock; this saves the wake-up.
CREATE OR REPLACE FUNCTION "public"."notify_node_ingested"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF new.type IS DISTINCT FROM 'branch'::node_type
     AND "public"."mantle_is_brain_space"(new.owner_id) THEN
    PERFORM pg_notify('node_ingested', new.id::text);
  END IF;
  RETURN new;
END
$$;
--> statement-breakpoint
-- A personal item has no facts and no graph edges, and the space role holds
-- no privilege on those tables: skip the reapers for it (otherwise a member
-- deleting their own page fails on a permission it must never have).
CREATE OR REPLACE FUNCTION "public"."reap_entity_edges_for_node"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT "public"."mantle_is_brain_space"(OLD.owner_id) THEN
    RETURN OLD;
  END IF;
  DELETE FROM public.entity_edges
   WHERE (source_kind = 'node' AND source_id = OLD.id)
      OR (target_kind = 'node' AND target_id = OLD.id);
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reap_facts_for_node"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT "public"."mantle_is_brain_space"(OLD.owner_id) THEN
    RETURN OLD;
  END IF;
  DELETE FROM public.facts
   WHERE source_node_id = OLD.id
     AND kind IN ('episodic', 'factual');
  UPDATE public.entity_edges
     SET data = data - 'source_node_id'
   WHERE data->>'source_node_id' = OLD.id::text;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

-- ── Row rules for personal spaces (plan 2b, review fix B3) ──────────────────
-- The personal-space role (mantle_view_space, made by ensureViewerRoles)
-- sees and writes ONLY the space its transaction names. No space set = no
-- rows, and every write refused. Workspace kinds only; a personal item never
-- carries a level (audience stays admin, so a mistaken re-own leaks nothing).
--
-- A submitted item is FROZEN (plan 2d, 2026-09-26): nobody edits or deletes
-- it until Accept, Return or Recall. The rule below holds it for the author;
-- admins never write personal items.
CREATE OR REPLACE FUNCTION "public"."mantle_space_item_frozen"(node uuid)
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM "public"."space_items" si
                  WHERE si.node_id = node AND si.review_state IN ('submitted', 'accepted'))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_id"()
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('mantle.login_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE POLICY "nodes_space_read" ON "public"."nodes" FOR SELECT
  TO mantle_view_space
  USING ("owner_id" = "public"."mantle_space_id"() AND "public"."mantle_workspace_kind"("type"));
--> statement-breakpoint
CREATE POLICY "nodes_space_insert" ON "public"."nodes" FOR INSERT
  TO mantle_view_space
  WITH CHECK ("owner_id" = "public"."mantle_space_id"()
              AND "public"."mantle_workspace_kind"("type") AND "audience" = 'admin');
--> statement-breakpoint
CREATE POLICY "nodes_space_update" ON "public"."nodes" FOR UPDATE
  TO mantle_view_space
  USING ("owner_id" = "public"."mantle_space_id"() AND "public"."mantle_workspace_kind"("type")
         AND NOT "public"."mantle_space_item_frozen"("id"))
  WITH CHECK ("owner_id" = "public"."mantle_space_id"()
              AND "public"."mantle_workspace_kind"("type") AND "audience" = 'admin');
--> statement-breakpoint
CREATE POLICY "nodes_space_delete" ON "public"."nodes" FOR DELETE
  TO mantle_view_space
  USING ("owner_id" = "public"."mantle_space_id"() AND "public"."mantle_workspace_kind"("type")
         AND NOT "public"."mantle_space_item_frozen"("id"));
--> statement-breakpoint

-- The body tables follow their node: the nodes rules apply inside the EXISTS.
-- Writes also need the node to be unfrozen.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pages', 'draws', 'tables'] LOOP
    EXECUTE format($f$
      CREATE POLICY %1$I ON "public".%2$I FOR SELECT TO mantle_view_space
        USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = %2$I."node_id"))$f$,
      t || '_space_read', t);
    EXECUTE format($f$
      CREATE POLICY %1$I ON "public".%2$I FOR INSERT TO mantle_view_space
        WITH CHECK (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = %2$I."node_id"))$f$,
      t || '_space_insert', t);
    EXECUTE format($f$
      CREATE POLICY %1$I ON "public".%2$I FOR UPDATE TO mantle_view_space
        USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = %2$I."node_id")
               AND NOT "public"."mantle_space_item_frozen"(%2$I."node_id"))
        WITH CHECK (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = %2$I."node_id"))$f$,
      t || '_space_update', t);
    EXECUTE format($f$
      CREATE POLICY %1$I ON "public".%2$I FOR DELETE TO mantle_view_space
        USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = %2$I."node_id")
               AND NOT "public"."mantle_space_item_frozen"(%2$I."node_id"))$f$,
      t || '_space_delete', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- space_items: the author's own rows. The member moves an item between
-- draft, submitted and returned only (Submit, Recall, Resubmit); 'accepted'
-- and the reviewer columns belong to the admin side. The app's one state
-- function holds the exact transitions; this is the floor under it.
ALTER TABLE "public"."space_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "space_items_space_read" ON "public"."space_items" FOR SELECT
  TO mantle_view_space
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "space_items"."node_id"));
--> statement-breakpoint
CREATE POLICY "space_items_space_insert" ON "public"."space_items" FOR INSERT
  TO mantle_view_space
  WITH CHECK (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "space_items"."node_id")
              AND "author_login_id" = "public"."mantle_login_id"()
              AND "review_state" = 'draft');
--> statement-breakpoint
CREATE POLICY "space_items_space_update" ON "public"."space_items" FOR UPDATE
  TO mantle_view_space
  USING (EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n.id = "space_items"."node_id")
         AND "author_login_id" = "public"."mantle_login_id"()
         AND "review_state" <> 'accepted')
  WITH CHECK ("author_login_id" = "public"."mantle_login_id"()
              AND "review_state" IN ('draft', 'submitted', 'returned')
              AND "accepted_at" IS NULL);
--> statement-breakpoint

-- ── Team drafts (plan 2d source "Team drafts") ──────────────────────────────
-- Other members' personal items shared with the team, readable by the TEAM
-- role only while mantle.human is on: a member's own request. An agent never
-- sets it, so a team-level agent never reads anyone's drafts. Published
-- columns only, like the Library (the draft columns are never granted).
CREATE POLICY "space_items_team_read" ON "public"."space_items" FOR SELECT
  TO mantle_view_team
  USING ("sharing" = 'team' AND current_setting('mantle.human', true) = 'on');
--> statement-breakpoint
CREATE POLICY "nodes_team_drafts_read" ON "public"."nodes" FOR SELECT
  TO mantle_view_team
  USING (current_setting('mantle.human', true) = 'on'
         AND "owner_id" IS DISTINCT FROM "public"."mantle_brain_id"()
         AND "public"."mantle_workspace_kind"("type")
         AND EXISTS (SELECT 1 FROM "public"."space_items" si
                      WHERE si.node_id = "nodes"."id" AND si.sharing = 'team'));
