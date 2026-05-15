-- Drop oauth_tokens_enc. Mantle no longer implements any OAuth flow
-- (Gmail and Outlook both connect via IMAP with app passwords, the
-- same path as any other provider). The column has been nullable and
-- unused since the OAuth code was removed; this just deletes the
-- vestigial schema.
--
-- The `email_provider` enum still includes 'gmail' and 'microsoft' for
-- historical reasons — Postgres enum value removal is gymnastic and
-- the unused values are harmless. The worker explicitly rejects them
-- if a row ever somehow gets created with one of those values.

alter table "public"."email_accounts"
  drop column if exists "oauth_tokens_enc";
