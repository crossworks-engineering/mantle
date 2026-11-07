-- A folder's hidden rows count another login's own items (per-login items,
-- nodes.login_id set): mantle_subtree_hidden (0282) asked only whether the
-- caller's scope reads a row (mantle_check_row 'read', its read_ws), which a
-- per-login item of another login passes when it sits in a shared folder.
-- So a move of that folder carried another login's private file with it,
-- and a delete reached the file. The trail (0311) already holds a row with
-- login_id to that login: this holds the subtree's count to the same rule.
--
-- mantle_subtree_hidden is 0282's, with one more arm: a row whose login_id
-- is set and is not the scope's login counts as hidden. The same security
-- attributes and search_path; mantle_subtree_refuse_hidden and
-- mantle_subtree_rewrite (0305) read it as before, so a move of such a
-- folder and its delete are refused 'hidden_rows'. No new table, no trigger,
-- no row changes, no LLM work.
-- Revert: packages/db/rollback/0364_subtree_hidden_login.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_subtree_hidden"(o uuid, p ltree)
  RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT CASE WHEN NOT "public"."mantle_caller_is_write_role"() THEN 0
              ELSE (SELECT count(*)::int FROM "public"."nodes" x
                     WHERE x."owner_id" = o AND x."path" <@ p
                       AND (NOT "public"."mantle_check_row"(x."home_ws", x."write_ws", x."read_ws", 'read')
                            OR (x."login_id" IS NOT NULL
                                AND x."login_id" IS DISTINCT FROM "public"."mantle_scope_login_id"())))
         END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_subtree_hidden"(uuid, ltree) FROM PUBLIC;
