/**
 * The records migration 0268 keeps when every login got one
 * MCP surface: the per-login MCP switch as it was (archive_mcp_login_access),
 * each agent's and tool group's level as it was (archive_tool_levels), and
 * the credential cutoff for a login with no switch row, written once
 * (archive_mcp_cutoff). Read by no product code (an archive: the level-reads
 * sweep skips this folder). No grant to any role: the admin pool and
 * definer functions only (access-matrix.ts).
 */
import { boolean, primaryKey, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const archiveMcpLoginAccess = pgTable('archive_mcp_login_access', {
  loginId: uuid('login_id').primaryKey(),
  enabled: boolean('enabled').notNull(),
  writeEnabled: boolean('write_enabled').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});

export const archiveToolLevels = pgTable(
  'archive_tool_levels',
  {
    /** 'agent' or 'tool_group' (a CHECK in 0268). */
    kind: text('kind').notNull(),
    rowId: uuid('row_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    slug: text('slug').notNull(),
    audience: text('audience').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.rowId] })],
);

export const archiveMcpCutoff = pgTable('archive_mcp_cutoff', {
  /** Always true: one row (a CHECK in 0268). */
  id: boolean('id').primaryKey().default(true),
  archivedAt: timestamp('archived_at', { withTimezone: true }).defaultNow().notNull(),
});
