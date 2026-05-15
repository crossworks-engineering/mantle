-- Mantle platform migration: extensions and Storage setup.
-- Owned by Supabase. App tables live in packages/db Drizzle migrations.

create extension if not exists "pgcrypto"  with schema extensions;
create extension if not exists "ltree"     with schema extensions;
create extension if not exists "vector"    with schema extensions;
create extension if not exists "pg_trgm"   with schema extensions;

-- Ensure the mantle bucket exists even if config.toml hasn't created it yet
-- (idempotent for repeat applies).
insert into storage.buckets (id, name, public, file_size_limit)
values ('mantle', 'mantle', false, 52428800)
on conflict (id) do nothing;
