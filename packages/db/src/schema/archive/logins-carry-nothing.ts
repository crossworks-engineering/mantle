/**
 * The records migration 0272 keeps when logins stopped
 * carrying anything: every client login as it was (archive_client_logins,
 * no password hash), the email-code sign-in tables and the retired static
 * login tokens as metadata only (never a code, a token hash, a request id
 * or an address), the role each key and peer was made under, and the
 * workspace rows a former client held on a brain already on workspaces
 * (archive_client_workspace_users) and its private workspace row
 * (archive_client_private_workspaces).
 *
 * archive_client_logins is also the list of former clients: their text stays client-sourced (packages/tools/src/client-sourced.ts),
 * an admin cannot re-enable one, an invite or a new login on one's email is
 * refused (packages/content/src/former-clients.ts), the login bridge gives
 * one no workspace and a brain not on workspaces that had one is not
 * switched at boot (0272). No grant to any role: the admin pool, the system
 * pool and definer functions only (access-matrix.ts).
 */
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const archiveClientLogins = pgTable('archive_client_logins', {
  loginId: uuid('login_id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  contactId: uuid('contact_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  sessionEpoch: integer('session_epoch').notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});

export const archiveClientWorkspaceUsers = pgTable(
  'archive_client_workspace_users',
  {
    workspaceId: uuid('workspace_id').notNull(),
    loginId: uuid('login_id').notNull(),
    moderator: boolean('moderator').notNull(),
    limits: jsonb('limits').notNull(),
    addedBy: uuid('added_by'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.loginId] })],
);

/** A former client's private workspace row as it was when it was removed:
 *  the review homes then rename that
 *  workspace "Former user" and register it. */
export const archiveClientPrivateWorkspaces = pgTable('archive_client_private_workspaces', {
  loginId: uuid('login_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});

export const archiveClientSigninCodes = pgTable('archive_client_signin_codes', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  loginId: uuid('login_id').notNull(),
  kind: text('kind').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  sendError: text('send_error'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});

export const archiveClientSigninCodeSkips = pgTable('archive_client_signin_code_skips', {
  id: uuid('id').primaryKey(),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});

export const archiveClientSigninSenderFolders = pgTable('archive_client_signin_sender_folders', {
  accountId: uuid('account_id').primaryKey(),
  folders: text('folders').array().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});

export const archiveMcpLoginTokens = pgTable('archive_mcp_login_tokens', {
  id: uuid('id').primaryKey(),
  loginId: uuid('login_id').notNull(),
  label: text('label').notNull(),
  sessionEpoch: integer('session_epoch').notNull(),
  createdBy: uuid('created_by'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});

export const archiveKeyRoles = pgTable('archive_key_roles', {
  keyId: uuid('key_id').primaryKey(),
  loginRole: text('login_role').notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});

export const archivePeerRoles = pgTable('archive_peer_roles', {
  peerId: uuid('peer_id').primaryKey(),
  actsAsRole: text('acts_as_role'),
  endedActsAsRole: text('ended_acts_as_role'),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});
