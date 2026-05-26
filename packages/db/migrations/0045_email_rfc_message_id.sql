-- Cross-folder dedup key: the RFC 5322 Message-ID header.
--
-- The existing (account_id, provider_msg_id) unique index dedups within a
-- single IMAP folder, but provider_msg_id encodes the folder name (see
-- packages/email/src/providers/imap.ts: `<folder>:<uidvalidity>:<uid>`), so
-- the same logical message appearing in INBOX + INBOX.Archive, or in any
-- Gmail folder + [Gmail]/All Mail, slips past dedup as two rows with two
-- different provider_msg_ids — feeding two extractor runs and bloating the
-- brain with duplicates.
--
-- The RFC 5322 Message-ID header is the same value across every folder and
-- every account that received the message (it's assigned by the sender's
-- MTA), so it's the right cross-folder key. Nullable because we can't
-- backfill historical rows without re-fetching every IMAP header, and
-- because some automated / malformed mail omits the header. Partial unique
-- index so the NULL rows can coexist freely while populated rows enforce
-- one-row-per-message-per-account.

alter table "public"."emails"
  add column if not exists "rfc_message_id" text;

create unique index if not exists "emails_account_rfc_msg_id_uq"
  on "public"."emails" ("account_id", "rfc_message_id")
  where "rfc_message_id" is not null;
