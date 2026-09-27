-- Member logins, session 7 audit fixes.
--
-- D3: an upload ledger per personal space. The daily upload cap summed the
-- files that still exist, so upload, delete, upload again reset it. Each
-- member upload now leaves a row here (bytes, time); the cap sums the last
-- 24 hours of rows. The space role may insert and read its own space's rows
-- only: no update or delete policy, so a member cannot erase the ledger.
CREATE TABLE IF NOT EXISTS "public"."space_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "space_id" uuid NOT NULL REFERENCES "public"."spaces"("id") ON DELETE CASCADE,
  "bytes" bigint NOT NULL CHECK ("bytes" >= 0),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_uploads_space_time_idx"
  ON "public"."space_uploads" ("space_id", "created_at");
--> statement-breakpoint
ALTER TABLE "public"."space_uploads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "space_uploads_space_read" ON "public"."space_uploads";
--> statement-breakpoint
CREATE POLICY "space_uploads_space_read" ON "public"."space_uploads" FOR SELECT
  TO mantle_view_space
  USING ("space_id" = "public"."mantle_space_id"());
--> statement-breakpoint
DROP POLICY IF EXISTS "space_uploads_space_insert" ON "public"."space_uploads";
--> statement-breakpoint
CREATE POLICY "space_uploads_space_insert" ON "public"."space_uploads" FOR INSERT
  TO mantle_view_space
  WITH CHECK ("space_id" = "public"."mantle_space_id"());
