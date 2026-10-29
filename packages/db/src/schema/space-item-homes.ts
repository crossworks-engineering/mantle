/**
 * Where each personal-space item goes when the spaces fold (0267) moves it
 * into the brain, and the grants it then gets (migration 0264). Recorded,
 * not granted: until the fold the items stay in their spaces, and
 * item_grants refuses a node a personal space owns (0244 rule 2). Written
 * by mantle_ws_review_off() only (the migration, and mantle_ws_migrate when
 * a brain switches later); read by the fold. No grant to any role: definer
 * functions and the admin pool only.
 *
 *  - private_workspaces: the login's private workspace, "<name> (only
 *    you)", the login its only user and a Moderator. Not a built-in
 *    workspace (bridge_key stays NULL).
 *  - former_user_workspaces: the "Former user" workspace (no users) of a
 *    login that is gone, one per former user. former_key is the former
 *    login's id while an archive row (or the event that made its private
 *    workspace) still names it, else its personal space's id (one space per
 *    login). A login deleted after its private workspace was made: the next
 *    run renames that workspace "Former user" and keys it by the login id.
 *    No foreign key: the record outlives the login and a purged space.
 *  - space_item_homes: one row per space item. home_workspace_id is the
 *    private (or Former user) workspace; for an accepted item, its author's,
 *    where the author's snapshot copy goes; for an accepted item whose
 *    author was erased before 0264, the home it has in the brain (no Former
 *    user workspace). A home that stops being a registered private or Former
 *    user workspace is moved on the next run. grant_admin, grant_team and
 *    write are the grants the fold writes besides the home (write is
 *    always false: Write off). state_before, sharing_before and author_role
 *    are the item's review state, sharing and author role before 0264.
 *    snapshot (the fold's RULE): the fold makes the author's snapshot copy
 *    of the item in its home only when snapshot is true, which is only for an accepted
 *    item whose home is a private or Former user workspace. An accepted
 *    item kept in a brain workspace (Admin, Team, any other) gets no copy.
 *    Every run sets it by that rule; a check keeps it off any item that
 *    was not accepted.
 *
 * The grant flags are not frozen: they come from state_before and from what
 * is live (sharing, the trash, the logins), and every run of
 * mantle_ws_review_off() refreshes them (app sharing and the app trash
 * still change until the fold). The fold runs it first, or applies the same
 * rule, when it moves the items.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users';
import { nodes } from './nodes';
import { workspaces } from './workspaces';

export const privateWorkspaces = pgTable('private_workspaces', {
  loginId: uuid('login_id')
    .primaryKey()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id')
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const formerUserWorkspaces = pgTable('former_user_workspaces', {
  formerKey: uuid('former_key').primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const spaceItemHomes = pgTable(
  'space_item_homes',
  {
    nodeId: uuid('node_id')
      .primaryKey()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    homeWorkspaceId: uuid('home_workspace_id')
      .notNull()
      .references(() => workspaces.id),
    grantAdmin: boolean('grant_admin').notNull().default(false),
    grantTeam: boolean('grant_team').notNull().default(false),
    write: boolean('write').notNull().default(false),
    stateBefore: text('state_before').notNull(),
    sharingBefore: text('sharing_before').notNull(),
    authorRole: text('author_role'),
    snapshot: boolean('snapshot').notNull().default(false),
    /** The author's snapshot copy once the app made it (0267:
     *  snapshot-copies.ts). No foreign key: a copy the author deletes leaves
     *  the record. */
    snapshotNodeId: uuid('snapshot_node_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('space_item_homes_home_idx').on(t.homeWorkspaceId),
    check(
      'space_item_homes_snapshot_accepted_ck',
      sql`NOT ${t.snapshot} OR ${t.stateBefore} = 'accepted'`,
    ),
  ],
);

/**
 * The spaces fold (migration 0267): one row per item a personal space
 * owned, moved into the brain (owner_id = the brain), with where it came
 * from (its space and login, its path and slug) and what it became (its
 * home, the Admin and Team grants, its new path and slug when a brain name
 * clashed). sharing and deleted_at are the space_items state it had at the
 * move (the member app trash). No foreign key: the record outlives the node
 * and the space. Read by the proof and workspaces:check; no grant to any
 * role.
 */
export const spaceFoldItems = pgTable(
  'space_fold_items',
  {
    nodeId: uuid('node_id').primaryKey(),
    spaceId: uuid('space_id').notNull(),
    loginId: uuid('login_id'),
    nodeType: text('node_type').notNull(),
    homeWorkspaceId: uuid('home_workspace_id').notNull(),
    grantAdmin: boolean('grant_admin').notNull(),
    grantTeam: boolean('grant_team').notNull(),
    sharing: text('sharing'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    oldPath: text('old_path').notNull(),
    newPath: text('new_path').notNull(),
    oldSlug: text('old_slug'),
    newSlug: text('new_slug'),
    foldedAt: timestamp('folded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('space_fold_items_home_idx').on(t.homeWorkspaceId)],
);
