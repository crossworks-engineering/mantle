-- Mantle Push (M5). Per-trigger toggles + quiet hours, single row, enforced
-- server-side by the send-worker. See push-notifications.md §10.

create table if not exists "public"."push_prefs" (
  "id" uuid primary key default gen_random_uuid(),
  "assistant_messages" boolean not null default true,
  "approvals" boolean not null default true,
  "quiet_enabled" boolean not null default false,
  "quiet_start" text not null default '22:00',
  "quiet_end" text not null default '07:00',
  "timezone" text not null default 'UTC',
  "singleton" boolean not null default true
);
--> statement-breakpoint
create unique index if not exists "push_prefs_singleton_uq" on "public"."push_prefs" ("singleton");
