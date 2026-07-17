import { sql } from 'drizzle-orm';
import { customType, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * PDF password vault. Financial statements often arrive password-protected
 * (commonly the last few digits of an ID number). When the extractor meets an
 * encrypted PDF email attachment, it tries each stored password to unlock and
 * read it. Sealed AES-256-GCM at rest (AAD = row id) — the password is an ID
 * fragment, so it's PII even if low-stakes. See the extractor's `encrypted_pdf`
 * path.
 */
export const pdfPasswords = pgTable(
  'pdf_passwords',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    label: text('label').notNull().default(''),
    passwordEnc: bytea('password_enc').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('pdf_passwords_owner_idx').on(t.ownerId)],
);

export type PdfPassword = typeof pdfPasswords.$inferSelect;
export type NewPdfPassword = typeof pdfPasswords.$inferInsert;
