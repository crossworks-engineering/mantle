-- Mantle Push (M2). Per-install relay identity + per-device subscriptions.
-- See ../../../mantle-companion/docs/push-notifications.md §8. No private keys,
-- no message bodies here — the instance token is stored encrypted at rest by the
-- app layer (@mantle/crypto), and routing tokens are revocable relay handles.

create table if not exists "public"."push_instance" (
  "id" uuid primary key default gen_random_uuid(),
  "instance_token_enc" text not null,
  "relay_instance_id" text not null,
  "relay_url" text not null default 'https://push.crossworks.network',
  "connected_at" timestamptz not null default now(),
  "singleton" boolean not null default true
);
--> statement-breakpoint
create unique index if not exists "push_instance_singleton_uq" on "public"."push_instance" ("singleton");
--> statement-breakpoint
create table if not exists "public"."push_subscriptions" (
  "id" uuid primary key default gen_random_uuid(),
  "owner_id" uuid not null,
  "relay_device_id" text,
  "routing_token" text not null,
  "public_key" text not null,
  "platform" text not null,
  "label" text,
  "created_at" timestamptz not null default now(),
  "last_push_at" timestamptz,
  constraint "push_subscriptions_platform_chk" check ("platform" in ('ios', 'android'))
);
--> statement-breakpoint
create index if not exists "push_subscriptions_owner_idx" on "public"."push_subscriptions" ("owner_id");
