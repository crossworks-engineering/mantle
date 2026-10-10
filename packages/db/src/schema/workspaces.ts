/**
 * Workspaces (plan page 4887b8e7, phase W1; migrations 0241 and 0242).
 *
 * A workspace has users (each with a Moderator tick), at most one assistant
 * and any number of connectors (workspace_resources). An item is shared by a
 * grant to a workspace (item_grants, the ONE truth for sharing), each with
 * its own Write switch; exactly one grant per item is its home. The derived
 * columns that row security reads (nodes.read_ws and the copies on chunks,
 * windows and facts) are kept by triggers, never by the app.
 *
 * W1 ships the model in shadow: nothing in the product reads these tables
 * yet.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users';
import { nodes } from './nodes';
import { spaces } from './spaces';

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Information only: who this workspace represents. Never a permission. */
    contactId: uuid('contact_id').references(() => nodes.id, { onDelete: 'set null' }),
    isAdmin: boolean('is_admin').notNull().default(false),
    /** Admin workspace users are Moderators here, kept by trigger. */
    adminModerated: boolean('admin_moderated').notNull().default(false),
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('workspaces_one_admin_uq')
      .on(t.ownerId)
      .where(sql`${t.isAdmin}`),
    uniqueIndex('workspaces_live_name_uq')
      .on(t.ownerId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export const workspaceUsers = pgTable(
  'workspace_users',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    loginId: uuid('login_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    moderator: boolean('moderator').notNull().default(false),
    /** Future per-user area switches (Admin workspace); empty = all on. */
    limits: jsonb('limits')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    addedBy: uuid('added_by').references(() => authUsers.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.loginId] }),
    index('workspace_users_login_idx').on(t.loginId),
  ],
);

export const itemGrants = pgTable(
  'item_grants',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    write: boolean('write').notNull().default(false),
    isHome: boolean('is_home').notNull().default(false),
    /** The folder this row is derived from; NULL = set on the item by hand. */
    viaFolderId: uuid('via_folder_id').references(() => nodes.id, { onDelete: 'cascade' }),
    /** "Removed here" against a folder's grant. */
    excluded: boolean('excluded').notNull().default(false),
    grantedBy: uuid('granted_by').references(() => authUsers.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.nodeId, t.workspaceId] }),
    index('item_grants_workspace_idx').on(t.workspaceId, t.nodeId),
    uniqueIndex('item_grants_one_home_uq')
      .on(t.nodeId)
      .where(sql`${t.isHome}`),
    index('item_grants_via_folder_idx')
      .on(t.viaFolderId)
      .where(sql`${t.viaFolderId} is not null`),
  ],
);

/** The resource types a workspace may hold. A new type is one more value
 *  here and in the CHECK of migration 0241. */
export const WORKSPACE_RESOURCE_TYPES = ['assistant', 'connector'] as const;
export type WorkspaceResourceType = (typeof WORKSPACE_RESOURCE_TYPES)[number];

export const workspaceResources = pgTable(
  'workspace_resources',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').$type<WorkspaceResourceType>().notNull(),
    refId: text('ref_id').notNull(),
    write: boolean('write').notNull().default(false),
    settings: jsonb('settings')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    addedBy: uuid('added_by').references(() => authUsers.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('workspace_resources_uq').on(t.workspaceId, t.type, t.refId),
    uniqueIndex('workspace_resources_one_assistant_uq')
      .on(t.workspaceId)
      .where(sql`${t.type} = 'assistant'`),
    uniqueIndex('workspace_resources_assistant_home_uq')
      .on(t.refId)
      .where(sql`${t.type} = 'assistant'`),
  ],
);

export const workspaceEvents = pgTable(
  'workspace_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    actorId: uuid('actor_id').references(() => authUsers.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    subject: jsonb('subject')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('workspace_events_ws_idx').on(t.workspaceId, t.at)],
);

/** One narrow row per node: every writer locks heads FIRST (plan U1). */
export const nodeAclHead = pgTable('node_acl_head', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
});

/** One row per (transaction, check) that missed its heads in 'warn' mode. */
export const headsCheckMisses = pgTable(
  'heads_check_misses',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
    checkName: text('check_name').notNull(),
    nodeId: uuid('node_id'),
    detail: text('detail'),
  },
  (t) => [index('heads_check_misses_at_idx').on(t.at)],
);

/**
 * The key the held-heads list is signed with (audit L6). One row, read only by
 * the security definer functions of 0241: no grant to any role, row security
 * on with no policy. The app never reads or writes it.
 */
export const mantleHeadsKey = pgTable(
  'mantle_heads_key',
  {
    id: boolean('id').primaryKey().default(true),
    k: text('k')
      .notNull()
      .default(sql`(gen_random_uuid()::text || gen_random_uuid()::text)`),
  },
  (t) => [check('mantle_heads_key_id_check', sql`${t.id}`)],
);

const xid8 = customType<{ data: string }>({ dataType: () => 'xid8' });

/**
 * The rows a statement moved, keyed by transaction id: written by the move
 * row trigger, taken by the statement trigger of the same transaction
 * (audit M2: never a session temp table). Unlogged, empty outside a running
 * statement; definer functions only.
 */
export const mantleMovedNodes = pgTable(
  'mantle_moved_nodes',
  {
    xid: xid8('xid').notNull(),
    id: uuid('id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.xid, t.id] })],
);

export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceUser = typeof workspaceUsers.$inferSelect;
export type ItemGrant = typeof itemGrants.$inferSelect;
export type WorkspaceResource = typeof workspaceResources.$inferSelect;
