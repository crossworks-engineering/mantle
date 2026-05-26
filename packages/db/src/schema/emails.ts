import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const emailProvider = pgEnum('email_provider', ['gmail', 'microsoft', 'imap']);

/**
 * `approve_list` — only ingest from senders the user has approved. New
 *   senders surface in `email_senders` as `pending` for curation. Used by
 *   IMAP by default (cheaper, opt-in).
 * `block_list` — ingest everything except `denied` senders. Suited to
 *   Gmail/M365 where the API does the heavy lifting.
 */
export const ingestPolicy = pgEnum('ingest_policy', ['approve_list', 'block_list']);

export const emailAccounts = pgTable(
  'email_accounts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id').notNull(),
    provider: emailProvider('provider').notNull(),
    address: text('address').notNull(),
    displayName: text('display_name'),
    // IMAP credentials, AES-GCM-encrypted (currently just the app password).
    imapConfigEnc: bytea('imap_config_enc'),
    // Non-secret IMAP knobs kept plaintext so the worker can connect without
    // unsealing per use. Password lives in `imapConfigEnc`.
    imapHost: text('imap_host'),
    imapPort: integer('imap_port'),
    imapSecure: boolean('imap_secure').default(true).notNull(),
    /** SMTP submission knobs for SENDING mail (migration 0041). Plaintext like
     *  the IMAP knobs; the password is the SAME app password already sealed in
     *  `imapConfigEnc` (providers accept one app-password for both IMAP + SMTP),
     *  so no new secret column. NULL host/port = sending disabled for this
     *  account. `smtpSecure` true → implicit TLS (465); false → STARTTLS (587). */
    smtpHost: text('smtp_host'),
    smtpPort: integer('smtp_port'),
    smtpSecure: boolean('smtp_secure').default(true).notNull(),
    /** @deprecated as of migration 0002. The adapter now auto-discovers
     *  folders each sync and uses `imapExcludedFolders` to opt out. Kept
     *  in the schema for historical reads only. */
    imapFolders: text('imap_folders').array().default(sql`'{INBOX}'::text[]`).notNull(),
    /** Folders to skip during auto-discovery. The defaults cover Trash,
     *  Junk/spam, Drafts, and Blocked across common naming conventions. */
    imapExcludedFolders: text('imap_excluded_folders')
      .array()
      .default(sql`'{INBOX.Trash, INBOX.Junk, INBOX.spam, INBOX.Drafts, INBOX.Blocked, Trash, Junk, Spam, Drafts}'::text[]`)
      .notNull(),
    /** Explicit allow-list of folders to scan (migration 0033). NULL/empty =
     *  legacy behaviour: auto-discover every folder minus `imapExcludedFolders`.
     *  Non-empty = scan ONLY these (still intersected with the server's real
     *  folder list and minus excluded, as a safety net). Set via the
     *  per-account folder-config UI; an empty selection clears back to NULL. */
    imapIncludedFolders: text('imap_included_folders').array(),
    /** How far back the FIRST scan of each folder reaches, in days (migration
     *  0034). Default 365 ≈ the previous hard-coded 12 months. Applied on the
     *  initial scan of a folder (and when uidvalidity rolls); lowering it later
     *  does not delete already-synced mail, and raising it only pulls older
     *  mail for folders not yet scanned. Set on the add/edit account form. */
    firstScanDays: integer('first_scan_days').default(365).notNull(),
    ingestPolicy: ingestPolicy('ingest_policy').default('approve_list').notNull(),
    /** Stable ltree path this account's mail lands under, e.g. `inbox.jason_sm`.
     *  Stored (not derived from address) so different `jason@…` accounts can
     *  coexist without colliding. Set at account-creation time. */
    branchPath: text('branch_path').notNull(),
    // Provider-specific sync cursor (history id, delta link, UID/modseq pair…).
    syncState: jsonb('sync_state').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('email_accounts_user_idx').on(t.userId),
    uniqueIndex('email_accounts_user_address_uq').on(t.userId, t.address),
  ],
);

export const emails = pgTable(
  'emails',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull().references(() => emailAccounts.id, { onDelete: 'cascade' }),
    /** Provider's stable message id (Gmail msg id, Graph message id, IMAP UID+UIDVALIDITY).
     *  Folder-scoped for IMAP — see `rfcMessageId` for the cross-folder key. */
    providerMsgId: text('provider_msg_id').notNull(),
    /** RFC 5322 Message-ID header, the same value across every folder/account
     *  that received the message. Used to dedup cross-folder (INBOX↔Archive,
     *  any-folder↔[Gmail]/All Mail). Nullable — historical rows pre-migration
     *  0045 don't have it, and some automated/malformed mail omits the
     *  header. A partial unique index on (account_id, rfc_message_id) WHERE
     *  rfc_message_id IS NOT NULL enforces uniqueness only when populated;
     *  see migration 0045. */
    rfcMessageId: text('rfc_message_id'),
    threadId: text('thread_id'),
    fromAddr: text('from_addr').notNull(),
    fromName: text('from_name'),
    toAddrs: text('to_addrs').array().default(sql`'{}'::text[]`).notNull(),
    ccAddrs: text('cc_addrs').array().default(sql`'{}'::text[]`).notNull(),
    bccAddrs: text('bcc_addrs').array().default(sql`'{}'::text[]`).notNull(),
    subject: text('subject'),
    snippet: text('snippet'),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),
    /** Provider-reported send time (internalDate / receivedDateTime / INTERNALDATE). */
    internalDate: timestamp('internal_date', { withTimezone: true }).notNull(),
    labels: text('labels').array().default(sql`'{}'::text[]`).notNull(),
    folder: text('folder'),
    isRead: boolean('is_read').default(false).notNull(),
    isStarred: boolean('is_starred').default(false).notNull(),
    hasAttachments: boolean('has_attachments').default(false).notNull(),
    sizeBytes: integer('size_bytes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Folder-scoped dedup key. Resuming a sync after a crash relies on this being unique.
    uniqueIndex('emails_account_msg_uq').on(t.accountId, t.providerMsgId),
    // Cross-folder dedup key (RFC 5322 Message-ID). Partial — only enforced
    // when populated, so historical rows (pre-0045) coexist freely and mail
    // missing the header doesn't collide. See migration 0045.
    uniqueIndex('emails_account_rfc_msg_id_uq')
      .on(t.accountId, t.rfcMessageId)
      .where(sql`${t.rfcMessageId} is not null`),
    index('emails_thread_idx').on(t.threadId),
    index('emails_internal_date_idx').on(t.internalDate),
    index('emails_node_idx').on(t.nodeId),
    index('emails_from_idx').on(t.fromAddr),
  ],
);

export const emailAttachments = pgTable(
  'email_attachments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    emailId: uuid('email_id').notNull().references(() => emails.id, { onDelete: 'cascade' }),
    /** Points at the deduped `file` node (one per unique sha256). */
    fileNodeId: uuid('file_node_id').notNull().references(() => nodes.id, { onDelete: 'restrict' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    sha256: text('sha256').notNull(),
    /** Object-storage key in the `mantle` bucket (see @mantle/storage). */
    storageKey: text('storage_key').notNull(),
    extractedText: text('extracted_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('email_attachments_email_idx').on(t.emailId),
    index('email_attachments_sha256_idx').on(t.sha256),
  ],
);

export type EmailAccount = typeof emailAccounts.$inferSelect;
export type NewEmailAccount = typeof emailAccounts.$inferInsert;
export type Email = typeof emails.$inferSelect;
export type NewEmail = typeof emails.$inferInsert;
export type EmailAttachment = typeof emailAttachments.$inferSelect;
export type NewEmailAttachment = typeof emailAttachments.$inferInsert;
