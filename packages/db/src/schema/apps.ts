import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
  manifest: jsonb('manifest')
    .$type<AppManifest>()
    .default(sql`'{}'::jsonb`)
    .notNull(),
  // Pointer to the last esbuild bundle of the DRAFT (preview) and of the
  // PUBLISHED source (go-live). A failed build never clobbers the last green
  // ref — see app_build.
  draftBuild: jsonb('draft_build').$type<BuildRef>(),
  publishedBuild: jsonb('published_build').$type<BuildRef>(),
  version: integer('version').default(1).notNull(),
  /** The snapshot seq a code-only restore put in the draft (migration 0219):
   *  the next publish records it as its version's `restored_from`, then
   *  clears it. */
  restoredFromSeq: integer('restored_from_seq'),
  // Informational (client logins C6, 0198): members and clients only READ the
  // app's database. Off, an app at team or client level is a shared workspace
  // everyone who runs it writes. Set only by the owner's app update route.
  dataReadOnly: boolean('data_read_only').default(false).notNull(),
  // MCP access (team apps Phase 1, 0234): a member's or client's MCP
  // connection reaches this app's data (the app_data_* tools) only while
  // this is on. Off by default. Set only by the owner's app update route.
  mcpAccess: boolean('mcp_access').default(false).notNull(),
  // Team apps Phase 3 (0235): the login that built the app (null for an
  // admin's), and the AUTHOR CEILING: its tools run at most at this level,
  // for every runner. A member builds at 'team'; an admin raises it to
  // 'admin' only when accepting the app, after seeing its declared tools.
  authorLoginId: uuid('author_login_id'),
  authorLevel: text('author_level').$type<AppAuthorLevel>().default('admin').notNull(),
  // True once the app ever ran at the ceiling (0236, a trigger sets it): the
  // admin's "Trust its tools" switch stays on its page after a trust.
  authorCeilingSeen: boolean('author_ceiling_seen').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** The author ceiling of an app (0235): 'team' for a member's app, until an
 *  admin accepts it with its tools trusted. */
export type AppAuthorLevel = 'admin' | 'team';

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
  /** Object-store key of the bundled ESM (content-addressed, see @mantle/storage contentKey). */
  storageKey: string;
  sha256: string;
  builtAt: string;
  esbuildVersion: string;
  bytes: number;
  ok: boolean;
  warnings?: string[];
  /** Companion per-app stylesheet (`text/css`); absent on pre-CSS builds and
   *  when the CSS compile degraded to a warning. */
  css?: { storageKey: string; sha256: string; bytes: number };
};

export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;
