-- PDF password vault. Many financial statements arrive password-protected
-- (typically the last N digits of an ID). When the extractor hits an encrypted
-- PDF, it tries each stored password to unlock + read it (see docs/federation
-- is unrelated — this is the email-attachment ingest path). Sealed AES-256-GCM
-- at rest like api_keys / secrets: the password is an ID fragment, so it's PII.
CREATE TABLE IF NOT EXISTS "pdf_passwords" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  -- Human label, e.g. "Nedbank — last 5 of ID". Plaintext (not secret).
  "label" text NOT NULL DEFAULT '',
  -- The password, sealed AES-256-GCM (AAD = row id).
  "password_enc" bytea NOT NULL,
  "key_version" integer NOT NULL DEFAULT 1,
  -- Bumped whenever this password successfully unlocks a PDF, so the UI can
  -- show which entries are pulling their weight and the extractor can try
  -- recently-useful ones first.
  "last_used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pdf_passwords_owner_idx" ON "pdf_passwords" ("owner_id");
