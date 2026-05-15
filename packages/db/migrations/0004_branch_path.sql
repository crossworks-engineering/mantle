-- Per-account branch path so emails always know which ltree path to land
-- under. Replaces the runtime `accountSlug(address)` derivation, which
-- collided for matching local-parts across providers
-- (e.g. jason@schoeman.me vs jason@gmail.com both produced `inbox.jason`).
--
-- For existing accounts we backfill the *legacy* slug so previously-ingested
-- mail keeps its current branch path — no data migration needed, no
-- split-brain between old and new ingests for the same account.

alter table "public"."email_accounts"
  add column if not exists "branch_path" text;

-- Backfill: any account that pre-dates this migration keeps the legacy slug
-- (just the local-part, non-alphanumerics replaced with `_`).
update "public"."email_accounts"
   set branch_path = 'inbox.' ||
       regexp_replace(lower(split_part(address, '@', 1)), '[^a-z0-9]', '_', 'g')
 where branch_path is null;

-- From here on, new accounts must specify branch_path explicitly. The
-- application layer (see actions.ts:addImapAccount) computes a slug that
-- includes a short domain hash so two `jason@…` accounts can coexist.
alter table "public"."email_accounts"
  alter column "branch_path" set not null;
