-- Configurable per-account history window for the first IMAP scan.
-- Replaces the hard-coded 12-month lookback in the IMAP adapter. Default 365
-- (≈ the old 12 months) so existing accounts are unchanged; the add/edit
-- account form lets the operator pick a shorter window (e.g. 30 days) for a
-- new account.

alter table "public"."email_accounts"
  add column if not exists "first_scan_days" integer not null default 365;
