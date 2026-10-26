import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users';
import { nodes } from './nodes';

/**
 * The canvas data store (DWG phase 7a, migration 0336): small JSON values a
 * Present canvas keeps through `mantle.data` (meeting marks, saved layouts,
 * suggestions, votes). NOT a canvas revision: a write here never changes
 * the canvas, its source or its rev. The contract (buckets, key format,
 * caps) is @mantle/content-core/canvas-data.
 *
 *  - `shared` rows: one per (canvas, key); `login_id` NULL. Every reader of
 *    the canvas reads them; a login with Write on the canvas writes them.
 *  - `mine` rows: one per (canvas, login, key); `login_id` the login whose
 *    entry it is. Its login writes it; a login with Write on the canvas
 *    reads everyone's.
 *
 * `bytes` is the size of the value as stored (its jsonb's text), which
 * every cap counts. `updated_by` is the login that last wrote the row,
 * `by_name` its display name then. A row goes with its canvas, and a `mine`
 * row with its login: the node_id, login_id and updated_by indexes keep
 * those cascades (and the definers' cap queries) off a table scan.
 */
export const canvasData = pgTable(
  'canvas_data',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    bucket: text('bucket').$type<'shared' | 'mine'>().notNull(),
    key: text('key').notNull(),
    loginId: uuid('login_id').references(() => authUsers.id, { onDelete: 'cascade' }),
    value: jsonb('value').notNull(),
    bytes: integer('bytes').notNull(),
    updatedBy: uuid('updated_by').references(() => authUsers.id, { onDelete: 'set null' }),
    /** The writer's display name when it wrote (a snapshot, as a comment's
     *  author_name): a reader's scope may not read other logins' profiles. */
    byName: text('by_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('canvas_data_shared_key_uq')
      .on(t.nodeId, t.key)
      .where(sql`${t.bucket} = 'shared'`),
    uniqueIndex('canvas_data_mine_key_uq')
      .on(t.nodeId, t.loginId, t.key)
      .where(sql`${t.bucket} = 'mine'`),
    index('canvas_data_node_idx').on(t.nodeId),
    index('canvas_data_login_idx')
      .on(t.loginId)
      .where(sql`${t.loginId} IS NOT NULL`),
    index('canvas_data_updated_by_idx')
      .on(t.updatedBy)
      .where(sql`${t.updatedBy} IS NOT NULL`),
    check(
      'canvas_data_bucket_ck',
      sql`(${t.bucket} = 'shared' AND ${t.loginId} IS NULL) OR (${t.bucket} = 'mine' AND ${t.loginId} IS NOT NULL)`,
    ),
  ],
);

export type CanvasDataRow = typeof canvasData.$inferSelect;
