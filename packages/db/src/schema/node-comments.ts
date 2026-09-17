import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { authUsers } from './auth-users';
import { nodes } from './nodes';

export type NodeCommentAuthorKind = 'owner' | 'member' | 'agent';

/**
 * Comments on a content node — tasks first, but node-generic by design so
 * pages/notes can adopt it without a migration. Flat, chronological,
 * multi-author; the discussion thread on a task's detail pane.
 *
 * `author_kind` distinguishes the three voices (same vocabulary as
 * `forum_posts`): `owner` is any admin login (`login_id` — logins share one
 * brain, so the name snapshot is what tells them apart), `member` is a
 * contact holding a team token (`contact_id`), `agent` is an assistant
 * (`agent_id`). All three author FKs go SET NULL on deletion with
 * `author_name` as the durable snapshot — a comment outlives its author.
 *
 * Attribution is stamped server-side from the authenticated session/surface,
 * NEVER from request bodies or model args (the team_request_create rule).
 */
export const nodeComments = pgTable(
  'node_comments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    authorKind: text('author_kind').$type<NodeCommentAuthorKind>().notNull(),
    loginId: uuid('login_id').references(() => authUsers.id, { onDelete: 'set null' }),
    contactId: uuid('contact_id').references(() => nodes.id, { onDelete: 'set null' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /** Display-name snapshot at post time. */
    authorName: text('author_name').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (t) => [
    // Drives the thread listing (and the per-task count subquery).
    index('node_comments_node_idx').on(t.nodeId, t.createdAt),
  ],
);

export type NodeCommentDbRow = typeof nodeComments.$inferSelect;
export type NewNodeComment = typeof nodeComments.$inferInsert;
