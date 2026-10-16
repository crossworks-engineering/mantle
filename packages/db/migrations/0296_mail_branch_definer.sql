-- A scoped read of an email attachment's rule (packages/db/src/
-- email-attachment.ts) and the Files key guard's folder check (packages/
-- files/src/email-attachments.ts pathReaches) read `email_accounts`, which
-- the workspace role is never granted (access-matrix.ts: none). In a scope
-- (an API key's call, a login's request) the read was refused (42501) and
-- the request answered the opaque 500: an area-limited key's list of pages,
-- notes or tables (withoutEmailCopies) on every brain on workspaces. Found
-- by arch A7, whose tests run every key on a brain on workspaces.
--
-- mantle_mail_branch_holds(owner, path, inclusive): whether `path` is under
-- one of `owner`'s mail account branches (inclusive: or is the branch
-- itself). Structure, never content: a boolean about a path the caller
-- names, the branch paths themselves never leave. In a scope only the
-- brain's own. A fixed search_path (pg_temp last), no right for PUBLIC,
-- EXECUTE for the workspace role (the write and runtime roles follow it,
-- as for 0293's definers) and the public demo's reader when it exists.
--
-- No row changes. Re-runnable. The `when` sits above 0295's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_mail_branch_holds"(owner uuid, path text, inclusive boolean)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."email_accounts" a
     WHERE a."user_id" = owner
       AND ((inclusive AND path = a."branch_path") OR starts_with(path, a."branch_path" || '.'))
       AND (NOT "public"."mantle_scope_active"() OR owner = "public"."mantle_brain_id"()))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_mail_branch_holds"(uuid, text, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_mail_branch_holds"(uuid, text, boolean) TO "mantle_view_user";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_mail_branch_holds"(uuid, text, boolean) TO demo_reader;
  END IF;
END
$$;
