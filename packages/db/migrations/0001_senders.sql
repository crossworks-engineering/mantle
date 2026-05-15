-- IMAP support + sender curation.
-- Adds: ingest_policy + sender_status enums; new columns on email_accounts;
-- email_senders + email_sender_domains tables; a SQL function that resolves
-- the effective decision for an (account, address) pair.

-- ─── enums ─────────────────────────────────────────────────────────────────
do $$ begin
  create type "public"."ingest_policy"        as enum ('approve_list', 'block_list');
exception when duplicate_object then null; end $$;

do $$ begin
  create type "public"."sender_status"        as enum ('pending', 'approved', 'denied');
exception when duplicate_object then null; end $$;

do $$ begin
  create type "public"."sender_domain_status" as enum ('approved', 'denied');
exception when duplicate_object then null; end $$;

-- ─── email_accounts: IMAP knobs + policy ──────────────────────────────────
alter table "public"."email_accounts"
  add column if not exists "imap_host"       text,
  add column if not exists "imap_port"       integer,
  add column if not exists "imap_secure"     boolean       not null default true,
  add column if not exists "imap_folders"    text[]        not null default '{INBOX}'::text[],
  add column if not exists "ingest_policy"   "public"."ingest_policy" not null default 'approve_list';

-- ─── email_senders ────────────────────────────────────────────────────────
create table if not exists "public"."email_senders" (
  "id"                uuid primary key default gen_random_uuid(),
  "user_id"           uuid not null references auth.users(id) on delete cascade,
  "source_account_id" uuid references "public"."email_accounts"(id) on delete set null,
  "address"           text not null,
  "domain"            text not null,
  "display_name"      text,
  "first_seen_at"     timestamptz not null default now(),
  "last_seen_at"      timestamptz not null default now(),
  "message_count"     integer not null default 0,
  "status"            "public"."sender_status" not null default 'pending',
  "decided_at"        timestamptz,
  "created_at"        timestamptz not null default now(),
  "updated_at"        timestamptz not null default now()
);
create unique index if not exists "email_senders_user_addr_uq"
  on "public"."email_senders" ("user_id", "address");
create index if not exists "email_senders_user_domain_idx"
  on "public"."email_senders" ("user_id", "domain");
create index if not exists "email_senders_user_status_idx"
  on "public"."email_senders" ("user_id", "status");
create index if not exists "email_senders_user_last_seen_idx"
  on "public"."email_senders" ("user_id", "last_seen_at");

-- ─── email_sender_domains ─────────────────────────────────────────────────
create table if not exists "public"."email_sender_domains" (
  "id"          uuid primary key default gen_random_uuid(),
  "user_id"     uuid not null references auth.users(id) on delete cascade,
  "domain"      text not null,
  "status"      "public"."sender_domain_status" not null,
  "decided_at"  timestamptz not null default now(),
  "created_at"  timestamptz not null default now(),
  "updated_at"  timestamptz not null default now()
);
create unique index if not exists "email_sender_domains_user_domain_uq"
  on "public"."email_sender_domains" ("user_id", "domain");

-- updated_at triggers for the new tables.
drop trigger if exists touch_email_senders on public.email_senders;
create trigger touch_email_senders before update on public.email_senders
  for each row execute function public.touch_updated_at();
drop trigger if exists touch_email_sender_domains on public.email_sender_domains;
create trigger touch_email_sender_domains before update on public.email_sender_domains
  for each row execute function public.touch_updated_at();

-- ─── decision resolver ────────────────────────────────────────────────────
-- Returns 'approved' | 'denied' | 'pending' for a given (user, address)
-- under an account's ingest_policy. Address rules win over domain rules;
-- absent rules fall back to the policy default.
create or replace function "public"."sender_effective_status"(
  p_user_id        uuid,
  p_address        text,
  p_ingest_policy  "public"."ingest_policy"
) returns "public"."sender_status" as $$
declare
  v_addr        text := lower(p_address);
  v_domain      text := split_part(v_addr, '@', 2);
  v_addr_status "public"."sender_status";
  v_dom_status  "public"."sender_domain_status";
begin
  -- 1. Address-level override always wins.
  select status into v_addr_status
    from public.email_senders
   where user_id = p_user_id and address = v_addr;
  if v_addr_status in ('approved', 'denied') then
    return v_addr_status;
  end if;

  -- 2. Domain decision.
  select status into v_dom_status
    from public.email_sender_domains
   where user_id = p_user_id and domain = v_domain;
  if v_dom_status is not null then
    return v_dom_status::text::public.sender_status;
  end if;

  -- 3. Fall through to policy default.
  if p_ingest_policy = 'block_list' then
    return 'approved'::public.sender_status;
  else
    return 'pending'::public.sender_status;
  end if;
end;
$$ language plpgsql stable;
