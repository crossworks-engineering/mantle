-- Client logins C5 audit fixes (I2, I3, I5, I8): what bounds a client's
-- comments and space, and what an admin sees of it.
--
-- 1. client_comment_ledger: one row per comment a CLIENT login writes (the
--    review talk in its own space, and the client thread on a client-level
--    item), so the daily comment cap (100 a day) cannot be reset by
--    deleting comments. The space role inserts and reads its own login's
--    rows (the review talk runs in the client's space); the client thread
--    is written on the admin pool, which records there too. No update or
--    delete rule for the space role: deleting a comment never refunds.
--
-- 2. client_quota_refusals: one row per client quota refusal (a full space,
--    the brain-wide total, the day's upload or submit budget, the item
--    limit, the comment caps), for Team admin > Clients. The reason and the
--    login only, never a filename or a body. Kept small: the app trims it to
--    the last 7 days and at most 500 rows on every insert.
--
-- 3. mantle_client_space_usage(): the bytes each client space holds, ONE
--    definition for the brain-wide client total and the admin card. It
--    counts files, table workbooks, page documents (saved doc, draft and
--    plain text) and note text, as stored (pg_column_size: what the rows
--    take on disk). A client space is a personal space whose login is a
--    client, or whose login was deleted (login_id NULL) while it holds items
--    a client wrote (space_items.author_role, 0194): a former client's space
--    keeps counting until the 30-day purge removes it. Starts from spaces
--    joined to auth.users and sums nodes by owner (indexed), with no
--    per-row function call (the 0194 version called the security-definer
--    mantle_client_space() for every file row of the brain).
--    mantle_client_space_bytes() is its sum; the space role may call only
--    that (one number), never the per-space rows.
--
-- 4. An index for the admin's client comment reads (the activity list and
--    delete-all-by-author): node_comments by client login.
--
-- Rollback: the previous release runs on this schema. It never reads the
-- new tables; its mantle_client_space_bytes() calls get the new body (a
-- larger number: page and note text count now), which only refuses client
-- uploads sooner.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- ── 1. The client comment ledger ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."client_comment_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "login_id" uuid NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_comment_ledger_login_time_idx"
  ON "public"."client_comment_ledger" ("login_id", "created_at");
--> statement-breakpoint
ALTER TABLE "public"."client_comment_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "client_comment_ledger_space_read" ON "public"."client_comment_ledger";
--> statement-breakpoint
CREATE POLICY "client_comment_ledger_space_read" ON "public"."client_comment_ledger" FOR SELECT
  TO mantle_view_space
  USING ("login_id" = "public"."mantle_login_id"());
--> statement-breakpoint
DROP POLICY IF EXISTS "client_comment_ledger_space_insert" ON "public"."client_comment_ledger";
--> statement-breakpoint
CREATE POLICY "client_comment_ledger_space_insert" ON "public"."client_comment_ledger" FOR INSERT
  TO mantle_view_space
  WITH CHECK ("login_id" = "public"."mantle_login_id"());
--> statement-breakpoint

-- ── 2. Client quota refusals ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."client_quota_refusals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "login_id" uuid REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_quota_refusals_created_idx"
  ON "public"."client_quota_refusals" ("created_at");
--> statement-breakpoint

-- ── 3. The bytes client spaces hold ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."mantle_client_space_usage"()
  RETURNS TABLE ("space_id" uuid, "login_id" uuid, "bytes" bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
  WITH cs AS (
    SELECT s.id, s.login_id
      FROM "public"."spaces" s
      LEFT JOIN "auth"."users" u ON u.id = s.login_id
     WHERE s.kind = 'personal'
       AND (u.role = 'client'
            OR (s.login_id IS NULL
                AND EXISTS (SELECT 1 FROM "public"."nodes" n
                              JOIN "public"."space_items" si ON si.node_id = n.id
                             WHERE n.owner_id = s.id AND si.author_role = 'client')))
  ),
  node_bytes AS (
    SELECT n.owner_id AS space_id,
           sum(CASE n.type
                 WHEN 'file' THEN coalesce((n.data->>'size_bytes')::bigint, 0)
                 WHEN 'note' THEN pg_column_size(n.data)::bigint
                 ELSE 0 END) AS b
      FROM "public"."nodes" n JOIN cs ON cs.id = n.owner_id
     GROUP BY n.owner_id
  ),
  page_bytes AS (
    SELECT n.owner_id AS space_id,
           sum(pg_column_size(p.doc)::bigint
               + coalesce(pg_column_size(p.draft_doc), 0)
               + pg_column_size(p.doc_text)) AS b
      FROM "public"."pages" p
      JOIN "public"."nodes" n ON n.id = p.node_id
      JOIN cs ON cs.id = n.owner_id
     GROUP BY n.owner_id
  ),
  table_bytes AS (
    SELECT n.owner_id AS space_id, sum(t.size_bytes)::bigint AS b
      FROM "public"."tables" t
      JOIN "public"."nodes" n ON n.id = t.node_id
      JOIN cs ON cs.id = n.owner_id
     GROUP BY n.owner_id
  )
  SELECT cs.id, cs.login_id,
         coalesce(nb.b, 0) + coalesce(pb.b, 0) + coalesce(tb.b, 0)
    FROM cs
    LEFT JOIN node_bytes nb ON nb.space_id = cs.id
    LEFT JOIN page_bytes pb ON pb.space_id = cs.id
    LEFT JOIN table_bytes tb ON tb.space_id = cs.id
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_client_space_usage"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_client_space_bytes"()
  RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
  SELECT coalesce(sum(u.bytes), 0)::bigint FROM "public"."mantle_client_space_usage"() u
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_client_space_bytes"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_client_space_bytes"() TO mantle_view_space;
--> statement-breakpoint

-- ── 4. Client comments by author ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "node_comments_client_author_idx"
  ON "public"."node_comments" ("login_id", "created_at")
  WHERE "author_kind" = 'client';
