import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * Draws: Excalidraw whiteboard scenes. The scene JSON is the source of truth
 * (`scene`, shape { elements, appState? }); `scene_text` is a derived
 * plaintext rendering the extractor + FTS read; `scene_svg` is a snapshot
 * captured client-side at commit that every non-editor surface renders.
 * Draw-level metadata (summary, visibility) lives on the parent `nodes` row
 * so tree/index scans stay lean — same split as `pages` / `tables`. One row
 * per draw (1:1 with its node).
 *
 * `file_refs` maps Excalidraw BinaryFile ids -> `file` node ids: pasted
 * images live in the files pipeline, never as dataURLs inside the scene.
 */
export const draws = pgTable('draws', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  scene: jsonb('scene')
    .$type<Record<string, unknown>>()
    .default(sql`'{"elements":[]}'::jsonb`)
    .notNull(),
  sceneText: text('scene_text').default('').notNull(),
  // SVG export of the committed scene (validated server-side before storing;
  // null when the committing client sent none or it failed validation). A
  // CACHE, not a source of truth: regenerable from `scene` by the browser
  // sidecar, so an empty one is a miss rather than a dead end.
  sceneSvg: text('scene_svg'),
  // Excalidraw version that produced `scene_svg`. NULL, or a value other than
  // the pinned one, means stale: re-render on next owner view or in bulk.
  svgEngine: text('svg_engine'),
  fileRefs: jsonb('file_refs')
    .$type<Record<string, string>>()
    .default(sql`'{}'::jsonb`)
    .notNull(),
  // Autosaved working copy (null when there are no uncommitted edits). Never
  // rendered or indexed; promoted into `scene` on commit.
  draftScene: jsonb('draft_scene').$type<Record<string, unknown>>(),
  draftUpdatedAt: timestamp('draft_updated_at', { withTimezone: true }),
  // Draft etag (optimistic concurrency): bumped on every draft write, commit,
  // and discard — the mirror of `pages.draft_rev`.
  draftRev: integer('draft_rev').default(0).notNull(),
  version: integer('version').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Draw = typeof draws.$inferSelect;
export type NewDraw = typeof draws.$inferInsert;
