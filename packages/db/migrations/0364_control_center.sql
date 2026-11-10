-- Control Center phase 1, the fleet user ban (docs/control-center.md).
--
-- On every box:
--  - auth.users.archived_at: a permanent disable (archive). An archived
--    login is a disabled login (the rule below), so sign-in needs no new
--    check. Nothing is deleted: what the login wrote keeps its author and
--    the audit log keeps its rows. Only a box Admin, by hand on the Users
--    screen, enables an archived login again (that clears both columns).
--  - control_disables: one marker per login the Control Center (CC)
--    disabled: the disabled_at it set. The CC enables a login again only
--    while its disabled_at is still that one, so a login a box Admin
--    disabled by hand, or disabled again after the CC, is never enabled by
--    the CC. An archive drops the marker. Written at the full-route spot
--    login-credential only (server/web lib/control/box.ts), read by the
--    narrow role.
--
-- On the CC only (empty on every other box):
--  - control_boxes: the subject boxes an Admin linked by URL, the last
--    run's result, and the last login list (ids, emails, flags and company
--    sign-in ids, for the fleet preview of a new ban).
--  - control_bans: a ban (emails, an optional issuer + object id, its kind:
--    disable or archive). Never deleted: a lift sets lifted_at.
--  - control_results: per ban, per box, what the last run matched.
--  - control_service: one row the control service writes: its public key
--    and when it last ran. The private key never reaches the database.
--
-- Grants come from the access matrix (applyViewerGrants), never from here.
-- Additive, no rewrite, no LLM work. Re-runnable.
-- Revert: packages/db/rollback/0364_control_center.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "auth"."users" ADD CONSTRAINT "users_archived_is_disabled_ck"
    CHECK ("archived_at" IS NULL OR "disabled_at" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."control_disables" (
  "login_id" uuid PRIMARY KEY NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "disabled_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."control_boxes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "url" text NOT NULL,
  "label" text,
  "added_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "run_requested_at" timestamp with time zone,
  "last_run_at" timestamp with time zone,
  "last_ok_at" timestamp with time zone,
  "last_reason" text,
  "last_result" jsonb,
  "logins" jsonb,
  CONSTRAINT "control_boxes_url_ck" CHECK ("url" ~ '^https://[^/?#]+$' AND char_length("url") <= 300),
  CONSTRAINT "control_boxes_label_ck" CHECK ("label" IS NULL OR char_length("label") <= 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "control_boxes_url_key" ON "public"."control_boxes" ("url");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."control_bans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text DEFAULT 'disable' NOT NULL,
  "emails" text[] DEFAULT '{}' NOT NULL,
  "issuer" text,
  "oid" text,
  "reason" text,
  "made_by" text,
  "made_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lifted_by" text,
  "lifted_at" timestamp with time zone,
  CONSTRAINT "control_bans_kind_ck" CHECK ("kind" IN ('disable', 'archive')),
  CONSTRAINT "control_bans_sign_in_ck" CHECK (("issuer" IS NULL) = ("oid" IS NULL)),
  CONSTRAINT "control_bans_key_ck" CHECK (cardinality("emails") > 0 OR "oid" IS NOT NULL),
  CONSTRAINT "control_bans_reason_ck" CHECK ("reason" IS NULL OR char_length("reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."control_results" (
  "ban_id" uuid NOT NULL REFERENCES "public"."control_bans"("id") ON DELETE CASCADE,
  "box_id" uuid NOT NULL REFERENCES "public"."control_boxes"("id") ON DELETE CASCADE,
  "matched" integer DEFAULT 0 NOT NULL,
  "owner_ids" uuid[] DEFAULT '{}' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("ban_id", "box_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."control_service" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "public_key" text NOT NULL,
  "last_tick_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "control_service_one_row_ck" CHECK ("id")
);
