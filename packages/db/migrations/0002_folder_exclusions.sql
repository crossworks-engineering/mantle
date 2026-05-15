-- Auto-discover IMAP folders.
-- Replaces the explicit `imap_folders` allow-list with an exclusion list.
-- The adapter now lists the server's folders each sync and scans every one
-- that isn't in `imap_excluded_folders`. New folders the server gains in
-- the future are picked up automatically.

alter table "public"."email_accounts"
  add column if not exists "imap_excluded_folders" text[] not null
    default '{INBOX.Trash, INBOX.Junk, INBOX.spam, INBOX.Drafts, INBOX.Blocked, Trash, Junk, Spam, Drafts}'::text[];

-- Backfill: any account that was created before this migration keeps
-- whatever defaults the column landed with. No data loss; the old
-- imap_folders allow-list is just no longer consulted by the adapter.
-- We leave the column in place so historical inspection still works.
comment on column "public"."email_accounts"."imap_folders" is
  'Deprecated as of 0002. The adapter no longer reads this; see imap_excluded_folders.';
