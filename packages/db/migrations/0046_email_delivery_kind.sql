-- Per-message delivery classification + per-sender rollup.
--
-- The senders page (/settings/senders) needs a soft hint of *who's a human
-- writing to you* vs *who's a newsletter* so the operator can clear pending
-- marketing in one glance. Source signal is the message headers we already
-- fetch on the cheap listSince path (List-Unsubscribe, Precedence,
-- Auto-Submitted, ESP fingerprints, Gmail labels) — see
-- packages/email/src/classify.ts for the rule cascade.
--
-- The per-message `delivery_kind` is the durable artifact; the per-sender
-- counters are a denormalised rollup so the senders UI can compute a pill
-- ratio without scanning `emails`. Both are bumped inside the same flow
-- that already touches the row (sync's upsertSenders + ingestOne), so
-- there's no extra write path.
--
-- `unknown` exists in the enum strictly as a back-compat default for
-- existing rows; the classifier itself never emits it. A backfill script
-- (Phase 3 of the work — scripts/classify-backfill.ts) flips historical
-- rows out of `unknown` by re-reading their headers.
--> statement-breakpoint

create type "public"."delivery_kind" as enum (
  'direct',
  'list',
  'automated',
  'marketing',
  'unknown'
);
--> statement-breakpoint

alter table "public"."emails"
  add column if not exists "delivery_kind" "delivery_kind" not null default 'unknown';
--> statement-breakpoint

create index if not exists "emails_delivery_kind_idx"
  on "public"."emails" ("delivery_kind");
--> statement-breakpoint

alter table "public"."email_senders"
  add column if not exists "direct_count"    integer not null default 0,
  add column if not exists "list_count"      integer not null default 0,
  add column if not exists "automated_count" integer not null default 0,
  add column if not exists "marketing_count" integer not null default 0;
