-- Secrets become a workspace kind (plan page 0f5ce59b, part S2; owner's
-- word 2026-11-26: people share passwords, .env files and logins with each
-- other, securely; not for apps or agents to use):
--  1. mantle_kind_class: 'secret' joins the workspace kinds. A secret has a
--     home and grants like a note. Every secret made before stays homed in
--     Admin with no grant: no member reads one until a person shares it.
--     Every user of the Admin workspace reads them now, not only the keys
--     area's (trusted logins: accepted, docs/secrets.md "Sharing").
--  2. mantle_secret_put (0281) also replaces the sealed value of a secret
--     that has one: an edit in a login's scope. The same check: the scope
--     may edit the secret.
--  3. mantle_secret_sealed(node): the sealed value of a secret, only in a
--     login's scope that reads the secret (no scope: nothing). The write role holds no right on the secrets
--     table; this and mantle_secret_put are its two doors (this one the
--     workspace role's, a read; put the write role's). It returns the
--     ciphertext only: the plaintext needs the master key, which only the
--     app holds, and only the reveal route opens it (and logs it).
--
-- No trigger, no LLM work, no change to existing rows. Re-runnable.
-- Revert: packages/db/rollback/0400_secrets_workspace_kind.revert.sql.
CREATE OR REPLACE FUNCTION "public"."mantle_kind_class"(t "public"."node_type")
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN t IN ('branch', 'file', 'note', 'page', 'table', 'app', 'formula', 'draw',
               'task', 'event', 'recall', 'present', 'secret') THEN 'workspace'
    WHEN t = 'telegram_message' THEN 'conversation'
    ELSE 'admin_only'
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_secret_put"(node uuid, sealed bytea, key_version integer)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n."id" = node AND n."type" = 'secret') THEN
    RAISE EXCEPTION 'mantle_secret_put: % is not a secret', node USING ERRCODE = '22023';
  END IF;
  -- The write role always carries a scope; with none it is refused.
  IF "public"."mantle_caller_is_write_role"() AND NOT "public"."mantle_scope_active"() THEN
    RAISE EXCEPTION 'not allowed to change this item' USING ERRCODE = '42501', DETAIL = 'no_edit';
  END IF;
  IF "public"."mantle_scope_active"()
     AND NOT coalesce("public"."mantle_check_item"(node, 'edit'), false) THEN
    PERFORM "public"."mantle_edit_refuse"('INSERT on secrets: a secret the scope may not edit',
      'no_edit', 'not allowed to change this item');
  END IF;
  INSERT INTO "public"."secrets" ("node_id", "ciphertext", "key_version")
  VALUES (node, sealed, coalesce(key_version, 1))
  ON CONFLICT ("node_id") DO UPDATE
    SET "ciphertext" = EXCLUDED."ciphertext",
        "key_version" = EXCLUDED."key_version",
        "updated_at" = now();
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_secret_put"(uuid, bytea, integer) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_secret_sealed"(node uuid)
  RETURNS bytea LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  c bytea;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n."id" = node AND n."type" = 'secret') THEN
    RETURN NULL;
  END IF;
  -- Only a login's scope that reads the secret gets it (the reveal and a
  -- partial edit always run in one): no scope, or a secret the scope does
  -- not read, answers as one that is not there, whatever role calls.
  IF NOT "public"."mantle_scope_active"()
     OR NOT coalesce("public"."mantle_check_item"(node, 'read'), false) THEN
    RETURN NULL;
  END IF;
  SELECT s."ciphertext" INTO c FROM "public"."secrets" s WHERE s."node_id" = node;
  RETURN c;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_secret_sealed"(uuid) FROM PUBLIC;
--> statement-breakpoint
-- A read: the workspace role's, so the write role's too (its function
-- rights are the workspace role's plus WRITE_ROLE_FUNCTIONS).
GRANT EXECUTE ON FUNCTION "public"."mantle_secret_sealed"(uuid) TO "mantle_view_user";
