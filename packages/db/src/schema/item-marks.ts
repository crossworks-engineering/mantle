import { index, integer, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * One login's marks on one item (the item tree, docs/folder-tree.md): a pin,
 * and how often and when it last opened the item. Recent and Most used read
 * the open columns; Pinned reads `pinned_at`. Per login, so two admins of one
 * brain each keep their own. A row goes with its item.
 */
export const itemMarks = pgTable(
  'item_marks',
  {
    /** The login (the session actor): the owner, an admin or a member. */
    actorId: uuid('actor_id').notNull(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    openCount: integer('open_count').default(0).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.actorId, t.nodeId] }),
    index('item_marks_actor_opened_idx').on(t.actorId, t.openedAt),
  ],
);

export type ItemMark = typeof itemMarks.$inferSelect;
