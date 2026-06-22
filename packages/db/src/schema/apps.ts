import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * Apps: mini apps the Appsmith agent authors as real TSX, bundled by esbuild
 * and rendered in a sandboxed iframe. The `source` virtual file tree is the
 * source of truth; `source_text` is a derived plaintext (concatenated source)
 * the extractor + FTS read. App-level metadata (icon, summary, visibility)
 * lives on the parent `nodes` row — same split as `pages` / `tables`. One row
 * per app (1:1 with its node).
 *
 * Draft/publish discipline mirrors pages: `draft_source` autosaves while
 * editing and never renders/indexes; `app_publish` promotes it into `source`
 * (and `draft_build` into `published_build`). The host only ever *runs* a
 * built artifact — see BuildRef.
 */
export const apps = pgTable('apps', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  source: jsonb('source')
    .$type<AppSource>()
    .default(sql`'{"entry":"App.tsx","files":{}}'::jsonb`)
    .notNull(),
  sourceText: text('source_text').default('').notNull(),
  // Autosaved working copy (null when there are no uncommitted edits). Never
  // rendered or indexed; promoted into `source` on publish.
  draftSource: jsonb('draft_source').$type<AppSource>(),
  draftUpdatedAt: timestamp('draft_updated_at', { withTimezone: true }),
  manifest: jsonb('manifest').$type<AppManifest>().default(sql`'{}'::jsonb`).notNull(),
  // Pointer to the last esbuild bundle of the DRAFT (preview) and of the
  // PUBLISHED source (go-live). A failed build never clobbers the last green
  // ref — see app_build.
  draftBuild: jsonb('draft_build').$type<BuildRef>(),
  publishedBuild: jsonb('published_build').$type<BuildRef>(),
  version: integer('version').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** A small virtual file tree: the entry file plus relative-imported siblings. */
export type AppSource = {
  /** Path of the entry module within `files`; must `export default App`. */
  entry: string;
  /** path → TSX/TS source. Bounded (~30 files / ~256 KB) to stay a mini app. */
  files: Record<string, string>;
};

/** The runtime contract the host enforces for a running app. */
export type AppManifest = {
  /** Declared api_tool slugs the app may call through the bridge — the host's
   *  runtime allowlist (every tool authored by the toolsmith / API Console). */
  toolSlugs?: string[];
  /** Declared SQLite schema: DDL run when the app's DB is provisioned. */
  sqlite?: { schemaSql: string; schemaVersion: number };
  /** One-liner for the app list card. */
  description?: string;
};

/** Pointer to a bundled artifact in object storage. */
export type BuildRef = {
  /** MinIO key of the bundled ESM (`app-bundles/<owner>/<app>/<sha>.js`). */
  storageKey: string;
  sha256: string;
  builtAt: string;
  esbuildVersion: string;
  bytes: number;
  ok: boolean;
  warnings?: string[];
};

export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;
