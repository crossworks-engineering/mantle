-- Workspaces W7b (plan 7.4, 5.4): one MCP surface for every login, and no
-- more agent or tool-group levels.
--
-- 1. The per-login MCP switch (mcp_login_access, 0227) is archived: every
--    login reaches MCP in its own workspaces, and a login carries no
--    permission of its own. archive_mcp_login_access keeps each row as it
--    was; the table stays (W8 drops it), frozen: a new row or a change to
--    its switches is refused. A delete still runs (a deleted login's row
--    goes with it).
-- 2. The agent and tool-group levels (agents.audience, tool_groups.audience)
--    are archived: archive_tool_levels keeps each agent's and each tool
--    group's level as it was. The columns stay (W8 drops them), frozen: an
--    update keeps the old value (no error, so the manifest's own writers,
--    which W8 removes, never fail a boot). A new row still takes what it is
--    given. A tool group is system-wide or adminOnly (tool_groups.admin_only,
--    0254); an assistant reads its workspace. Nothing reads the level.
--
-- Both freezes yield to a named migration bypass (mantle_heads_bypass_on),
-- like the item levels' (0261). Nothing here changes who reads what.
--
-- 3. No credential comes back to life (W7b fix round 1, M3). With the
--    switch gone, a credential the switch had stopped would work again, so
--    it is ended or narrowed here, by the archived switch: every static
--    login token (mtlmcpk_; minting is retired) is revoked; a login whose
--    MCP was off has its OAuth grants revoked and the peers bound to it
--    disabled; a login whose MCP was on with Write off keeps its OAuth
--    grants and its peers read-only (the grant's scope carries
--    `mantle:read-only`, which a refresh keeps; the peer's write switch
--    off). The API keys (mtlk_) by the same switch (W7b fix round 2, M-b):
--    a key of a login whose MCP was off is revoked, one of a login whose
--    Write was off is read-only. A member or client login with no switch
--    row never reached MCP: its keys were made for /api/v1, so they stay
--    there (`api_only`, which resolveMcpCaller refuses), and a peer bound
--    to it is disabled. An admin login's keys never went through the
--    switch, so a leftover switch row of an admin changes none of them
--    (W7b fix round 3). Only credentials made before the archive are
--    touched (for a login with no row, before the first run: the cutoff
--    archive_mcp_cutoff records once, W7b fix round 3, so a later run on a
--    brain with no switch row and no agent never reads now()). The
--    credential tables are locked for the section, so none is made or
--    changed half way through it. It only narrows, starts no work, and a
--    second run changes nothing.

-- The triggers below take a lock on agents and tool_groups, and section 3
-- locks the credential tables: wait at most 30 s for each (0165), never
-- queue behind a long transaction.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- ── 1. The records ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "public"."archive_mcp_login_access" (
  "login_id"      uuid PRIMARY KEY,
  "enabled"       boolean NOT NULL,
  "write_enabled" boolean NOT NULL,
  "updated_at"    timestamptz NOT NULL,
  "archived_at"   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."archive_tool_levels" (
  "kind"        text NOT NULL CHECK ("kind" IN ('agent', 'tool_group')),
  "row_id"      uuid NOT NULL,
  "owner_id"    uuid NOT NULL,
  "slug"        text NOT NULL,
  "audience"    text NOT NULL,
  "archived_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("kind", "row_id")
);
--> statement-breakpoint
-- The cutoff of section 3 for a login with no switch row: one row, written
-- on the first run, read on every run (W7b fix round 3).
CREATE TABLE IF NOT EXISTS "public"."archive_mcp_cutoff" (
  "id"          boolean PRIMARY KEY DEFAULT true CHECK ("id"),
  "archived_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Admin pool and definer functions only (access-matrix.ts).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['archive_mcp_login_access', 'archive_tool_levels', 'archive_mcp_cutoff'] LOOP
    EXECUTE format('ALTER TABLE "public".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON "public".%I FROM PUBLIC', t);
  END LOOP;
END
$$;
--> statement-breakpoint
INSERT INTO "public"."archive_mcp_login_access" ("login_id", "enabled", "write_enabled", "updated_at")
SELECT a."login_id", a."enabled", a."write_enabled", a."updated_at"
  FROM "public"."mcp_login_access" a
ON CONFLICT ("login_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "public"."archive_tool_levels" ("kind", "row_id", "owner_id", "slug", "audience")
SELECT 'agent', a."id", a."owner_id", a."slug", a."audience" FROM "public"."agents" a
UNION ALL
SELECT 'tool_group', g."id", g."owner_id", g."slug", g."audience" FROM "public"."tool_groups" g
ON CONFLICT ("kind", "row_id") DO NOTHING;
--> statement-breakpoint
-- The first run's time (a brain that ran an earlier form of this file keeps
-- the time its records already carry). A later run leaves it as it is.
INSERT INTO "public"."archive_mcp_cutoff" ("archived_at")
SELECT coalesce(
         (SELECT min(x."archived_at") FROM (
            SELECT "archived_at" FROM "public"."archive_mcp_login_access"
            UNION ALL
            SELECT "archived_at" FROM "public"."archive_tool_levels") x),
         now())
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- ── 2. The freezes ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "public"."mantle_mcp_login_access_frozen_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF "public"."mantle_heads_bypass_on"() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT'
     OR (OLD."enabled", OLD."write_enabled") IS DISTINCT FROM (NEW."enabled", NEW."write_enabled") THEN
    RAISE EXCEPTION 'the per-login MCP switch is gone: every login reaches MCP in its own workspaces (workspaces W7b)'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_mcp_login_access_frozen_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_login_access_frozen" ON "public"."mcp_login_access";
--> statement-breakpoint
CREATE TRIGGER "mcp_login_access_frozen"
  BEFORE INSERT OR UPDATE ON "public"."mcp_login_access"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_mcp_login_access_frozen_trg"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_tool_levels_frozen_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF OLD."audience" IS DISTINCT FROM NEW."audience" AND NOT "public"."mantle_heads_bypass_on"() THEN
    NEW."audience" := OLD."audience";
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_tool_levels_frozen_trg"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agents_level_frozen" ON "public"."agents";
--> statement-breakpoint
CREATE TRIGGER "agents_level_frozen"
  BEFORE UPDATE OF "audience" ON "public"."agents"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_tool_levels_frozen_trg"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "tool_groups_level_frozen" ON "public"."tool_groups";
--> statement-breakpoint
CREATE TRIGGER "tool_groups_level_frozen"
  BEFORE UPDATE OF "audience" ON "public"."tool_groups"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_tool_levels_frozen_trg"();
--> statement-breakpoint

-- ── 3. No credential comes back to life ───────────────────────────────────────

-- The API keys (W7b fix round 2, M-b). `api_only`: the key works on
-- /api/v1 only, never on /api/mcp. Set here only; a new key is made
-- without it (every login reaches MCP since W7b).
ALTER TABLE "public"."access_keys"
  ADD COLUMN IF NOT EXISTS "api_only" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- No credential is made or changed while this section narrows them (W7b
-- fix round 3): a key, a grant, a code or a peer made half way through
-- would miss the updates that read the same rows. Writes wait (at most
-- lock_timeout, above); reads of the other four tables go on. access_keys
-- is not read either until the commit: the ALTER above already holds its
-- ACCESS EXCLUSIVE lock, which a transaction keeps to its end.
-- The order is the one the code takes them in (access_keys, then the
-- OAuth code, then the OAuth tokens: server/web/lib/mcp-oauth.ts
-- exchangeClaimed), then the peers and the login tokens, which nothing
-- locks together with these: no deadlock with a token exchange.
LOCK TABLE "public"."access_keys", "public"."oauth_auth_codes", "public"."oauth_access_tokens",
  "public"."mantle_peers", "public"."mcp_login_tokens" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
UPDATE "public"."mcp_login_tokens" SET "revoked_at" = now() WHERE "revoked_at" IS NULL;
--> statement-breakpoint
UPDATE "public"."oauth_access_tokens" t SET "revoked_at" = now()
  FROM "public"."archive_mcp_login_access" a
 WHERE t."actor_id" = a."login_id" AND NOT a."enabled"
   AND t."revoked_at" IS NULL AND t."created_at" <= a."archived_at";
--> statement-breakpoint
DELETE FROM "public"."oauth_auth_codes" c
 USING "public"."archive_mcp_login_access" a
 WHERE c."actor_id" = a."login_id" AND NOT a."enabled" AND c."created_at" <= a."archived_at";
--> statement-breakpoint
UPDATE "public"."mantle_peers" p SET "enabled" = false
  FROM "public"."archive_mcp_login_access" a
 WHERE p."acts_as_login_id" = a."login_id" AND NOT a."enabled"
   AND p."enabled" AND p."created_at" <= a."archived_at";
--> statement-breakpoint
UPDATE "public"."oauth_access_tokens" t
   SET "scope" = btrim(t."scope" || ' mantle:read-only')
  FROM "public"."archive_mcp_login_access" a
 WHERE t."actor_id" = a."login_id" AND a."enabled" AND NOT a."write_enabled"
   AND t."revoked_at" IS NULL AND t."created_at" <= a."archived_at"
   AND NOT ('mantle:read-only' = ANY (string_to_array(t."scope", ' ')));
--> statement-breakpoint
UPDATE "public"."mantle_peers" p SET "write_enabled" = false
  FROM "public"."archive_mcp_login_access" a
 WHERE p."acts_as_login_id" = a."login_id" AND a."enabled" AND NOT a."write_enabled"
   AND p."write_enabled" AND p."created_at" <= a."archived_at";
--> statement-breakpoint
-- The API keys by the same switch, a member's or a client's only: an admin
-- login's keys never went through it (W7b fix round 3).
UPDATE "public"."access_keys" k SET "revoked_at" = now()
  FROM "public"."archive_mcp_login_access" a
 WHERE k."login_id" = a."login_id" AND NOT a."enabled" AND k."login_role" IN ('member', 'client')
   AND k."revoked_at" IS NULL AND k."created_at" <= a."archived_at";
--> statement-breakpoint
UPDATE "public"."access_keys" k SET "access" = 'read'
  FROM "public"."archive_mcp_login_access" a
 WHERE k."login_id" = a."login_id" AND a."enabled" AND NOT a."write_enabled"
   AND k."login_role" IN ('member', 'client')
   AND k."access" <> 'read' AND k."revoked_at" IS NULL AND k."created_at" <= a."archived_at";
--> statement-breakpoint
UPDATE "public"."access_keys" k SET "api_only" = true
 WHERE k."login_role" IN ('member', 'client') AND NOT k."api_only" AND k."revoked_at" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "public"."archive_mcp_login_access" a
                    WHERE a."login_id" = k."login_id")
   AND k."created_at" <= (SELECT c."archived_at" FROM "public"."archive_mcp_cutoff" c);
--> statement-breakpoint
UPDATE "public"."mantle_peers" p SET "enabled" = false
 WHERE p."acts_as_role" IN ('member', 'client') AND p."enabled"
   AND NOT EXISTS (SELECT 1 FROM "public"."archive_mcp_login_access" a
                    WHERE a."login_id" = p."acts_as_login_id")
   AND p."created_at" <= (SELECT c."archived_at" FROM "public"."archive_mcp_cutoff" c);
