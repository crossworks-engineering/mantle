-- Mantle app schema. Extensions, the storage bucket, and the auth schema are
-- owned by Supabase platform migrations (see supabase/migrations/).

-- ─── enums ─────────────────────────────────────────────────────────────────
do $$ begin
  create type "public"."node_type" as enum (
    'branch','email','email_thread','file','note','sermon',
    'contact','secret','task','event','printer_project'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type "public"."email_provider" as enum ('gmail','microsoft','imap');
exception when duplicate_object then null; end $$;

-- ─── profiles (mirrors auth.users.id) ─────────────────────────────────────
create table if not exists "public"."profiles" (
  "user_id"      uuid primary key references auth.users(id) on delete cascade,
  "display_name" text,
  "preferences"  jsonb not null default '{}'::jsonb,
  "created_at"   timestamptz not null default now(),
  "updated_at"   timestamptz not null default now()
);

-- ─── nodes (the tree) ─────────────────────────────────────────────────────
create table if not exists "public"."nodes" (
  "id"          uuid primary key default gen_random_uuid(),
  "owner_id"    uuid not null references auth.users(id) on delete cascade,
  "parent_id"   uuid references "public"."nodes"(id) on delete cascade,
  "type"        "public"."node_type" not null,
  "title"       text not null,
  "slug"        text,
  "data"        jsonb not null default '{}'::jsonb,
  "path"        ltree not null,
  "tags"        text[] not null default '{}'::text[],
  "embedding"   vector(1536),
  -- Generated full-text vector — title weighted A, data text weighted B.
  "search_tsv"  tsvector generated always as (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("data"::text, '')), 'B')
  ) stored,
  "created_at"  timestamptz not null default now(),
  "updated_at"  timestamptz not null default now()
);

create index if not exists "nodes_owner_idx"    on "public"."nodes"("owner_id");
create index if not exists "nodes_parent_idx"   on "public"."nodes"("parent_id");
create index if not exists "nodes_type_idx"     on "public"."nodes"("type");
create unique index if not exists "nodes_owner_slug_uq"
  on "public"."nodes"("owner_id", "slug") where "slug" is not null;
create index if not exists "nodes_path_idx"     on "public"."nodes" using gist("path");
create index if not exists "nodes_tags_idx"     on "public"."nodes" using gin("tags");
create index if not exists "nodes_search_idx"   on "public"."nodes" using gin("search_tsv");
-- Vector index added after first batch of rows; ivfflat needs data to train.
-- See packages/search for the helper that issues it.

-- ─── email accounts / emails / attachments ────────────────────────────────
create table if not exists "public"."email_accounts" (
  "id"               uuid primary key default gen_random_uuid(),
  "user_id"          uuid not null references auth.users(id) on delete cascade,
  "provider"         "public"."email_provider" not null,
  "address"          text not null,
  "display_name"     text,
  "oauth_tokens_enc" bytea,
  "imap_config_enc"  bytea,
  "sync_state"       jsonb not null default '{}'::jsonb,
  "last_sync_at"     timestamptz,
  "last_sync_error"  text,
  "enabled"          boolean not null default true,
  "created_at"       timestamptz not null default now(),
  "updated_at"       timestamptz not null default now()
);
create index if not exists "email_accounts_user_idx" on "public"."email_accounts"("user_id");
create unique index if not exists "email_accounts_user_address_uq"
  on "public"."email_accounts"("user_id", "address");

create table if not exists "public"."emails" (
  "id"               uuid primary key default gen_random_uuid(),
  "node_id"          uuid not null references "public"."nodes"(id) on delete cascade,
  "account_id"       uuid not null references "public"."email_accounts"(id) on delete cascade,
  "provider_msg_id"  text not null,
  "thread_id"        text,
  "from_addr"        text not null,
  "from_name"        text,
  "to_addrs"         text[] not null default '{}'::text[],
  "cc_addrs"         text[] not null default '{}'::text[],
  "bcc_addrs"        text[] not null default '{}'::text[],
  "subject"          text,
  "snippet"          text,
  "body_text"        text,
  "body_html"        text,
  "internal_date"    timestamptz not null,
  "labels"           text[] not null default '{}'::text[],
  "folder"           text,
  "is_read"          boolean not null default false,
  "is_starred"       boolean not null default false,
  "has_attachments"  boolean not null default false,
  "size_bytes"       integer,
  "created_at"       timestamptz not null default now(),
  "updated_at"       timestamptz not null default now()
);
create unique index if not exists "emails_account_msg_uq" on "public"."emails"("account_id", "provider_msg_id");
create index if not exists "emails_thread_idx"        on "public"."emails"("thread_id");
create index if not exists "emails_internal_date_idx" on "public"."emails"("internal_date" desc);
create index if not exists "emails_node_idx"          on "public"."emails"("node_id");
create index if not exists "emails_from_idx"          on "public"."emails"("from_addr");
create index if not exists "emails_labels_idx"        on "public"."emails" using gin("labels");

create table if not exists "public"."email_attachments" (
  "id"             uuid primary key default gen_random_uuid(),
  "email_id"       uuid not null references "public"."emails"(id) on delete cascade,
  "file_node_id"   uuid not null references "public"."nodes"(id) on delete restrict,
  "filename"       text not null,
  "mime_type"      text,
  "size_bytes"     bigint,
  "sha256"         text not null,
  "storage_key"    text not null,
  "extracted_text" text,
  "created_at"     timestamptz not null default now()
);
create index if not exists "email_attachments_email_idx"  on "public"."email_attachments"("email_id");
create index if not exists "email_attachments_sha256_idx" on "public"."email_attachments"("sha256");

-- ─── secrets (AES-256-GCM ciphertext) ─────────────────────────────────────
create table if not exists "public"."secrets" (
  "id"          uuid primary key default gen_random_uuid(),
  "node_id"     uuid not null unique references "public"."nodes"(id) on delete cascade,
  "ciphertext"  bytea not null,
  "key_version" integer not null default 1,
  "created_at"  timestamptz not null default now(),
  "updated_at"  timestamptz not null default now()
);

-- ─── ingest rules ─────────────────────────────────────────────────────────
create table if not exists "public"."ingest_rules" (
  "id"         uuid primary key default gen_random_uuid(),
  "user_id"    uuid not null references auth.users(id) on delete cascade,
  "name"       text not null,
  "account_id" uuid references "public"."email_accounts"(id) on delete cascade,
  "when"       jsonb not null,
  "then"       jsonb not null,
  "priority"   integer not null default 100,
  "enabled"    boolean not null default true,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index if not exists "ingest_rules_user_idx"     on "public"."ingest_rules"("user_id");
create index if not exists "ingest_rules_priority_idx" on "public"."ingest_rules"("priority");

-- ─── saved filters ────────────────────────────────────────────────────────
create table if not exists "public"."saved_filters" (
  "id"         uuid primary key default gen_random_uuid(),
  "user_id"    uuid not null references auth.users(id) on delete cascade,
  "name"       text not null,
  "query"      jsonb not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index if not exists "saved_filters_user_idx" on "public"."saved_filters"("user_id");

-- ─── updated_at triggers ──────────────────────────────────────────────────
create or replace function "public"."touch_updated_at"() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','nodes','email_accounts','emails','secrets','ingest_rules','saved_filters'
  ] loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s', t);
    execute format(
      'create trigger touch_%1$s before update on public.%1$s
       for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;
