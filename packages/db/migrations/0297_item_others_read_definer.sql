-- Whether others can read an item (packages/tools/src/shared-item.ts
-- othersCanRead), the rule that an API key or a linked brain never changes
-- the content of an item others read (key-shared-content.ts), read
-- `workspaces` and `shares` in the caller's scope. The workspace role reads
-- only the scope's own workspaces, so in a scope (a key's MCP call, a
-- peer's) an item held by a workspace the key's login is not a user of
-- read as held by nobody, and the key's content tool changed it with no
-- refusal. Found by arch A7, whose tests run every key on a brain on
-- workspaces (access-keys-scope F1); on main the test ran unscoped.
--
-- mantle_item_others_read(owner, item): a workspace other than Admin holds
-- the item (its read_ws), or it has a live link (an open one or a contact
-- share). A boolean about an item the caller names; which workspaces or
-- links never leave it. In a scope it answers only for an item of the
-- brain the scope reads (the row rule of nodes, 0242, on the scope's login
-- as 0291's definers read it): any other item, missing or not, is NULL, so
-- a scope learns nothing of an item it cannot read (no one-bit oracle of
-- its holders or links). NULL is the refusing answer: othersCanRead reads
-- it as "others read it" (a content change refused), never as "no one
-- does". Its callers read the item's row in their scope first, so on a
-- viewer or the write role an item the scope cannot read never reaches
-- the definer, and every answer they get is the one before.
-- A fixed search_path (pg_temp last), no right for PUBLIC, EXECUTE
-- for the workspace role (the write and runtime roles follow it, as for
-- 0293's definers) and the public demo's reader when it exists.
--
-- No row changes. Re-runnable. The `when` sits above 0296's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_item_others_read"(owner uuid, item uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT CASE
    WHEN "public"."mantle_scope_active"() AND NOT EXISTS (
      SELECT 1 FROM "public"."nodes" r
       WHERE r."id" = item AND r."owner_id" = owner AND owner = "public"."mantle_brain_id"()
         AND r."read_ws" && "public"."mantle_scope_ws"()
         AND (r."login_id" IS NULL OR r."login_id" = "public"."mantle_scope_login_id"()))
    THEN NULL
    ELSE EXISTS (
      SELECT 1 FROM "public"."nodes" n
       WHERE n."id" = item AND n."owner_id" = owner
         AND (EXISTS (SELECT 1 FROM "public"."workspaces" w
                       WHERE w."id" = ANY (n."read_ws") AND NOT w."is_admin")
              OR EXISTS (SELECT 1 FROM "public"."shares" s
                          WHERE s."node_id" = n."id" AND s."owner_id" = n."owner_id"
                            AND s."revoked_at" IS NULL
                            AND (s."expires_at" IS NULL OR s."expires_at" > now()))))
  END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_item_others_read"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_item_others_read"(uuid, uuid) TO "mantle_view_user";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_item_others_read"(uuid, uuid) TO demo_reader;
  END IF;
END
$$;
