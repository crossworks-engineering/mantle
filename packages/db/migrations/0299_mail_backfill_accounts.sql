-- The mail accounts a contact's backfill is queued for (packages/email
-- backfill-queue.ts enqueueBackfill): adding a contact, or an address to
-- one, pulls that sender's last 90 days of mail from each enabled account.
-- The queue read email_accounts in the caller's scope, a table no workspace
-- scope reads (access-matrix.ts: none), so in a request scope (every
-- login's write since F4) and in an assistant's turn the read was refused,
-- the error swallowed and no backfill queued, in every actor check mode.
--
-- mantle_mail_backfill_accounts(owner): each enabled account's id and
-- provider (which worker owns it), never an address, a host or a secret.
-- With no scope set (the system pool: the discover-senders page, a
-- worker) it answers as the system pool read; in a scope only for one that
-- holds the Admin workspace (mail and contacts are Admin's) and only the
-- brain's own accounts, else no row. A fixed search_path (pg_temp last),
-- no right for PUBLIC, EXECUTE for the workspace role (the write and
-- runtime roles follow it, as for 0293's definers). Not the public demo's
-- reader (F4 fix round 3, L4): a read-only demo queues no backfill.
--
-- No row changes. Re-runnable. The `when` sits above 0298's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_mail_backfill_accounts"(owner uuid)
  RETURNS TABLE(id uuid, provider text) LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT a."id", a."provider"::text FROM "public"."email_accounts" a
   WHERE a."user_id" = owner AND a."enabled"
     AND (NOT "public"."mantle_scope_active"()
          OR (owner = "public"."mantle_brain_id"() AND "public"."mantle_scope_is_admin"()))
   ORDER BY a."id"
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_mail_backfill_accounts"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_mail_backfill_accounts"(uuid) TO "mantle_view_user";
