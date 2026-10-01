-- Contact shares (docs/sharing.md, "Contact shares"): one workspace item
-- shared with one contact, opened with the item's own link plus the
-- contact's personal code. The item's level never changes, so the team never
-- sees it. No login, no role, no tools; apps may write only with can_write.
--
-- 1. contact_share_codes: one row per contact that ever had sharing. Sharing
--    is on while code_hash is set. code_hash is an HMAC keyed from
--    MANTLE_MASTER_KEY (HKDF, fixed label), so a copy of the database alone
--    recovers no code. code_epoch only goes up (regenerate, switch off), so
--    a visitor cookie of an older epoch never matches again. The row is kept
--    while the contact exists; deleting the contact removes it.
--    failed_attempts / failed_since: the per-contact failure count of the
--    current day window; 30 in a day sets locked_until for 24 hours. They
--    live in the row, so a restart or a second web process does not reset
--    them.
-- 2. shares.contact_id (a contact share) and shares.can_write (apps only).
--    The one open link per item stays one; each contact gets its own live
--    share per item (shares_node_open_uq, shares_node_contact_uq).
-- 3. share_access_log: what a contact did on a contact share (open, asset,
--    query, write, refused, code_failed). Reaped after 90 days by the
--    app-access-log-reap sweep.
-- 4. needs_you_changed fires when a contact's sharing locks or unlocks: a
--    locked contact is an admin notice in "Needs you".
--
-- No viewer grant on any new table or column: the /s layer reads and writes
-- them on the admin pool, for the brain.

SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."contact_share_codes" (
  "contact_id"      uuid PRIMARY KEY NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "owner_id"        uuid NOT NULL,
  "code_hash"       text,
  "code_epoch"      integer NOT NULL DEFAULT 1,
  "disabled_at"     timestamptz,
  "failed_attempts" integer NOT NULL DEFAULT 0,
  "failed_since"    timestamptz,
  "locked_until"    timestamptz,
  "last_used_at"    timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "rotated_at"      timestamptz,
  CONSTRAINT "contact_share_codes_epoch_ck" CHECK ("code_epoch" >= 1),
  CONSTRAINT "contact_share_codes_attempts_ck" CHECK ("failed_attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_share_codes_owner_idx"
  ON "public"."contact_share_codes" ("owner_id");
--> statement-breakpoint

-- The row names a contact node of the same owner.
CREATE OR REPLACE FUNCTION "public"."mantle_contact_share_code_check"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" n
     WHERE n.id = new.contact_id AND n.owner_id = new.owner_id AND n.type = 'contact'
  ) THEN
    RAISE EXCEPTION 'contact_share_codes: % is not a contact of this owner', new.contact_id
      USING ERRCODE = '23514';
  END IF;
  RETURN new;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "contact_share_codes_check_trg" ON "public"."contact_share_codes";
--> statement-breakpoint
CREATE TRIGGER "contact_share_codes_check_trg"
  BEFORE INSERT OR UPDATE OF "contact_id", "owner_id" ON "public"."contact_share_codes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_contact_share_code_check"();
--> statement-breakpoint

-- A lock starting or ending moves the "Needs you" count (0186's event).
DROP TRIGGER IF EXISTS "contact_share_codes_needs_you_trg" ON "public"."contact_share_codes";
--> statement-breakpoint
CREATE TRIGGER "contact_share_codes_needs_you_trg"
  AFTER UPDATE OF "locked_until" ON "public"."contact_share_codes"
  FOR EACH ROW
  WHEN (old.locked_until IS DISTINCT FROM new.locked_until)
  EXECUTE FUNCTION "public"."mantle_notify_needs_you"();
--> statement-breakpoint

ALTER TABLE "public"."shares"
  ADD COLUMN IF NOT EXISTS "contact_id" uuid REFERENCES "public"."nodes"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."shares"
  ADD COLUMN IF NOT EXISTS "can_write" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "public"."shares" DROP CONSTRAINT IF EXISTS "shares_can_write_ck";
--> statement-breakpoint
ALTER TABLE "public"."shares"
  ADD CONSTRAINT "shares_can_write_ck"
  CHECK (NOT "can_write" OR ("contact_id" IS NOT NULL AND "node_type" = 'app'));
--> statement-breakpoint

-- A contact share names a contact node of the same owner, on a workspace
-- item of that owner that is not a folder (decision 2: no folder contact
-- shares in v1) and not a contact.
CREATE OR REPLACE FUNCTION "public"."mantle_contact_share_check"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  IF new.contact_id IS NULL THEN
    RETURN new;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" c
     WHERE c.id = new.contact_id AND c.owner_id = new.owner_id AND c.type = 'contact'
  ) THEN
    RAISE EXCEPTION 'shares: contact % is not a contact of this owner', new.contact_id
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" n
     WHERE n.id = new.node_id AND n.owner_id = new.owner_id
       AND n.type = new.node_type
       AND "public"."mantle_workspace_kind"(n.type)
       AND n.type <> 'branch'
  ) THEN
    RAISE EXCEPTION 'shares: a contact share needs a workspace item that is not a folder'
      USING ERRCODE = '23514';
  END IF;
  RETURN new;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "shares_contact_check_trg" ON "public"."shares";
--> statement-breakpoint
CREATE TRIGGER "shares_contact_check_trg"
  BEFORE INSERT OR UPDATE OF "contact_id", "node_id", "node_type", "owner_id" ON "public"."shares"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_contact_share_check"();
--> statement-breakpoint

-- One open link per item (unchanged), one live share per contact per item.
CREATE UNIQUE INDEX IF NOT EXISTS "shares_node_open_uq"
  ON "public"."shares" ("node_id")
  WHERE "revoked_at" IS NULL AND "contact_id" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "public"."shares_node_active_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shares_node_contact_uq"
  ON "public"."shares" ("node_id", "contact_id")
  WHERE "revoked_at" IS NULL AND "contact_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shares_contact_idx"
  ON "public"."shares" ("contact_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."share_access_log" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"   uuid NOT NULL,
  "share_id"   uuid NOT NULL REFERENCES "public"."shares"("id") ON DELETE CASCADE,
  "contact_id" uuid REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "kind"       text NOT NULL,
  "detail"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "share_access_log_kind_ck"
    CHECK ("kind" IN ('open', 'asset', 'query', 'write', 'refused', 'code_failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_access_log_share_idx"
  ON "public"."share_access_log" ("share_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_access_log_contact_idx"
  ON "public"."share_access_log" ("contact_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_access_log_created_idx"
  ON "public"."share_access_log" ("created_at");
