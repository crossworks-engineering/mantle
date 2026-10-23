import {
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/** Postgres `bytea` as a Node Buffer (the poster PNG). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** What the save step reads off a canvas without running it. */
export type PresentMeta = {
  /** `canvas:size`: the design size, or 'fill' for the whole viewport. */
  size: { w: number; h: number } | 'fill';
  /** `canvas:theme`: follow the owner's theme, or the fixed light palette. */
  theme: 'follow' | 'fixed';
  /** The library specifiers the canvas imports, and the classic scripts it
   *  loads (meta.libs, section 6.2). */
  libs: string[];
  scripts: string[];
  /** `canvas:poster-at`, seconds, or null. */
  posterAt: number | null;
};

/**
 * Presents: agent-written HTML canvases (the Present workspace,
 * docs/proposals/canvas-files.md section 4.1). A present is a `nodes` row
 * with type='present' plus this 1:1 sidecar, the same split as `draws`.
 *
 * `source` is the canvas, the whole HTML document, and the source of truth.
 * There is no draft and no commit: a save is live at once (latest is
 * latest), and `rev` is only the optimistic-concurrency etag that keeps two
 * writers from overwriting each other.
 *
 * `source_text` is derived (content-core canvasText) for search and the
 * extractor; `css` is the Tailwind utilities compiled from the source on
 * save. `poster_png` is a CACHE of the rendered picture, never the source,
 * and `poster_rev` the rev it was made from (stale when it differs).
 *
 * `index_due_at` is the quiet-period rule (section 4.3): a save whose text
 * changed sets it a few minutes ahead, every later save pushes it on, and
 * the item is re-indexed once, when it passes. A colour change costs nothing.
 */
export const presents = pgTable('presents', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  source: text('source').default('').notNull(),
  sourceText: text('source_text').default('').notNull(),
  meta: jsonb('meta').$type<PresentMeta>().notNull(),
  css: text('css').default('').notNull(),
  posterPng: bytea('poster_png'),
  posterRev: integer('poster_rev'),
  rev: integer('rev').default(1).notNull(),
  indexDueAt: timestamp('index_due_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * The last versions of a canvas's source (decision 4: keep 10), so a bad
 * agent rewrite can be undone. Written on every save that changed the
 * source; the oldest beyond the limit are dropped in the same transaction.
 * Shares always show the latest, never a revision.
 */
export const presentRevisions = pgTable(
  'present_revisions',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    rev: integer('rev').notNull(),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.rev] })],
);

export type Present = typeof presents.$inferSelect;
export type NewPresent = typeof presents.$inferInsert;
export type PresentRevision = typeof presentRevisions.$inferSelect;
