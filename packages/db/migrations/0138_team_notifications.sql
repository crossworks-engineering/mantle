-- Member-to-member notifications, with reply-in-place.
--
-- From a real Pinnacle forum topic (2026-07-21): a member asked the responder
-- to notify a colleague; it answered — correctly — that it had no way to reach
-- anyone, so the ask degraded to "go tell her yourself and point her at this
-- thread", while the responder was sitting in that thread and knew its id.
--
-- Modelled as a THREAD, not a toast: the recipient replies without leaving
-- what they're doing, so notification-plus-replies is one grouping from the
-- start rather than a ping that later grows a reply box. The root row carries
-- its OWN id in thread_id; replies carry the root's.
--
-- recipient_id / sender_id hold a contact node id for a member or the OWNER's
-- id for the owner — the same dual convention as forum_read_cursors.reader_id,
-- and why neither carries an FK (the owner is not a node). sender_name is
-- captured at send time so a thread stays readable after a contact is revoked.

create table if not exists "public"."team_notifications" (
  "id"            uuid primary key default gen_random_uuid(),
  "owner_id"      uuid not null,
  "thread_id"     uuid not null,
  "recipient_id"  uuid not null,
  "sender_id"     uuid not null,
  "sender_name"   text,
  "body"          text not null,
  "topic_id"      uuid,
  "post_id"       uuid,
  "read_at"       timestamptz,
  "created_at"    timestamptz not null default now()
);

-- The inbox query: one person's notifications, newest first.
create index if not exists "team_notifications_inbox_idx"
  on "public"."team_notifications" ("owner_id", "recipient_id", "created_at" desc);

-- One thread and its replies, in order.
create index if not exists "team_notifications_thread_idx"
  on "public"."team_notifications" ("thread_id", "created_at");

-- ── Realtime ────────────────────────────────────────────────────────────────
-- Payload is the RECIPIENT id, not the owner id — deliberately unlike
-- runs_changed/pending_changed, which broadcast owner-wide. A notification is
-- per-recipient state: broadcasting owner-wide would wake every connected
-- surface for a message meant for one person, and the bridge would then have
-- to re-derive the recipient to know whom to repaint. The owner id rides along
-- so the bridge can scope its fan-out without a lookup.
--
-- INSERT only, plus an UPDATE narrowed to read_at with a WHEN clause: those
-- are the two transitions a surface renders. Anything else would be a notify
-- storm repainting nothing (the lesson 0135's WHEN clauses encode).
--
-- NOTIFY is transactional, so nothing is delivered for a rolled-back turn, and
-- identical payloads raised inside one transaction collapse into one delivery.
-- The notification is ADVISORY: the row is the truth and every surface catches
-- up on its next load.
create or replace function "public"."notify_team_notification"()
  returns trigger language plpgsql as $$
begin
  perform pg_notify(
    'team_notification_changed',
    json_build_object(
      'ownerId', new.owner_id::text,
      'recipientId', new.recipient_id::text
    )::text
  );
  return new;
end
$$;

drop trigger if exists "team_notifications_ins_trg" on "public"."team_notifications";
create trigger "team_notifications_ins_trg"
  after insert on "public"."team_notifications"
  for each row execute function "public"."notify_team_notification"();

drop trigger if exists "team_notifications_read_trg" on "public"."team_notifications";
create trigger "team_notifications_read_trg"
  after update on "public"."team_notifications"
  for each row
  when (old."read_at" is distinct from new."read_at")
  execute function "public"."notify_team_notification"();
