-- Remove push quiet hours (docs/reminder-delivery-routing.md §C). OS-level Do
-- Not Disturb covers night-time muting for a mobile app, so the send-worker no
-- longer reads a quiet window. Drop the now-unused columns from the single-row
-- push_prefs table. `if exists` keeps a partial replay safe.
alter table "public"."push_prefs" drop column if exists "quiet_enabled";
--> statement-breakpoint
alter table "public"."push_prefs" drop column if exists "quiet_start";
--> statement-breakpoint
alter table "public"."push_prefs" drop column if exists "quiet_end";
--> statement-breakpoint
alter table "public"."push_prefs" drop column if exists "timezone";
