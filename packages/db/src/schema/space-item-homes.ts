/**
 * Where each personal-space item goes when W6b moves it into the brain, and
 * the grants it then gets (migration 0264, W5c, plan 9.3). Recorded, not
 * granted: until W6b the items stay in their spaces, and item_grants refuses
 * a node a personal space owns (0244 rule 2). Written by
 * mantle_ws_review_off() only (the migration, and mantle_ws_migrate when a
 * brain switches later); read by W6b. No grant to any role: definer
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
 *    where the author's snapshot copy goes (S3); for an accepted item whose
 *    author was erased before 0264, the home it has in the brain (no Former
 *    user workspace). A home that stops being a registered private or Former
 *    user workspace is moved on the next run. grant_admin, grant_team
 *    and write are the grants W6b writes besides the home (write is always
 *    false: Write off). state_before, sharing_before and author_role are the
 *    item's review state, sharing and author role before 0264.
 *
 * The grant flags are not frozen: they come from state_before and from what
 * is live (sharing, the trash, the logins), and every run of
 * mantle_ws_review_off() refreshes them (app sharing and the app trash
 * still change until W6b). W6b runs it first, or applies the same rule,
 * when it moves the items (W5c contract).
 */
import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('space_item_homes_home_idx').on(t.homeWorkspaceId)],
);
