/**
 * Apps surface. An app is a `nodes` row with type='app' plus an `apps` sidecar
 * holding the source virtual file tree, the manifest, and build-artifact
 * pointers:
 *
 *   nodes.title           display name
 *   nodes.data.icon       optional emoji or `lucide:<name>` (projectAppIcon)
 *   nodes.data.color      optional tile tint key (APP_TINTS)
 *   nodes.data.summary    extractor-written summary (if 'app' is extracted)
 *   apps.source           { entry, files } — built + run
 *   apps.source_text      derived plaintext (concatenated source; FTS reads this)
 *   apps.manifest         { toolSlugs, sqlite, description }
 *   apps.draft_*          autosaved working copy + its last preview build
 *
 * All under the `apps` ltree root, lazy-created on first write. Draft/publish
 * discipline mirrors pages: drafts autosave and never render/index; `publishApp`
 * promotes the draft (source + build) into the published columns.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import {
  asViewerLevel,
  db,
  nodes,
  apps,
  appDatabases,
  shares,
  notifyNodeIngested,
  type Node,
  type AppSource,
  type AppManifest,
  type BuildRef,
} from '@mantle/db';
import { loadProfilePreferences } from './profile-preferences';
import { notifyAppNavChanged } from './app-nav';
import { codeHash, insertNodeSnapshot } from './node-snapshot-rows';
import type { AppRow, AppDetail, AppTint } from '@mantle/client-types';
import { projectAppIcon, projectAppTint } from '@mantle/content-core/app-nav';
export type { AppRow, AppDetail };

export const APPS_ROOT_LABEL = 'apps';

/** A fresh app: one entry file with a trivial component. */
export const DEFAULT_ENTRY = 'App.tsx';
export function emptySource(): AppSource {
  return {
    entry: DEFAULT_ENTRY,
    files: {
      [DEFAULT_ENTRY]:
        'export default function App() {\n  return <div className="p-4 text-foreground">New app</div>;\n}\n',
    },
  };
}

/** Source-tree limits. Enforced in the content layer so BOTH the web autosave
 *  route and the agent's app_file_write share one ceiling (the agent path used
 *  to be uncapped). The web route's zod schema references these too. */
export const MAX_APP_FILES = 50;
export const MAX_APP_FILE_BYTES = 256 * 1024;
export const MAX_APP_PATH_LEN = 256;

export class AppSourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppSourceLimitError';
  }
}

/** Throw AppSourceLimitError if a source tree exceeds the file-count, per-file
 *  size, or path-length ceilings. Covers a single-file write too (build `next`
 *  then validate). */
export function assertSourceWithinLimits(source: AppSource): void {
  const paths = Object.keys(source.files);
  if (paths.length > MAX_APP_FILES) {
    throw new AppSourceLimitError(`too many files (${paths.length}; max ${MAX_APP_FILES})`);
  }
  for (const p of paths) {
    if (p.length > MAX_APP_PATH_LEN) {
      throw new AppSourceLimitError(
        `file path too long (max ${MAX_APP_PATH_LEN} chars): ${p.slice(0, 80)}`,
      );
    }
    const bytes = Buffer.byteLength(source.files[p] ?? '', 'utf8');
    if (bytes > MAX_APP_FILE_BYTES) {
      throw new AppSourceLimitError(
        `file '${p}' too large (${bytes} bytes; max ${MAX_APP_FILE_BYTES})`,
      );
    }
  }
}

type SidecarCols = {
  source: AppSource;
  draftSource: AppSource | null;
  /** Set by listApps, which reads `draft_source IS NOT NULL` rather than the
   *  draft itself; wins over `draftSource` for `hasDraft`. */
  hasDraft?: boolean;
  manifest: AppManifest;
  draftBuild: BuildRef | null;
  publishedBuild: BuildRef | null;
  /** settings of the node's ACTIVE share, null when unshared/revoked. */
  shareSettings: Record<string, unknown> | null;
  /** prefs.teamHubAppId — resolved once per query, compared per row. */
  hubAppId: string | null;
  /** apps.data_read_only: informational (client logins C6). */
  dataReadOnly: boolean;
  /** apps.draft_updated_at: detail only (the editor's save check). */
  draftUpdatedAt?: Date | null;
};

/** The node columns an app row shows (listApps reads only these). */
type RowNode = Pick<
  Node,
  | 'id'
  | 'title'
  | 'data'
  | 'tags'
  | 'audience'
  | 'inheritedLevel'
  | 'embeddedLevel'
  | 'createdAt'
  | 'updatedAt'
>;

function rowOf(n: RowNode, s: Partial<SidecarCols> = {}): AppRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const manifest = (s.manifest ?? {}) as AppManifest;
  return {
    id: n.id,
    title: n.title,
    // Stored icons predate validation; project on read so a client only ever
    // sees a shape it can render.
    icon: projectAppIcon(d.icon) ?? null,
    color: projectAppTint(d.color) ?? null,
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    description: typeof manifest.description === 'string' ? manifest.description : null,
    toolCount: manifest.toolSlugs?.length ?? 0,
    hasBuild: !!s.publishedBuild?.ok,
    hasDraft: s.hasDraft ?? s.draftSource != null,
    // Every live link is open: team links are retired (migration 0176).
    shareMode: s.shareSettings ? 'public' : null,
    isHub: s.hubAppId != null && s.hubAppId === n.id,
    audience: asViewerLevel(n.audience),
    inherited:
      n.inheritedLevel === 'team' || n.inheritedLevel === 'client' ? n.inheritedLevel : null,
    embedded: n.embeddedLevel === 'team' || n.embeddedLevel === 'client' ? n.embeddedLevel : null,
    dataReadOnly: s.dataReadOnly === true,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

function detailOf(n: Node, s: SidecarCols): AppDetail {
  return {
    ...rowOf(n, s),
    source: s.source,
    draft: s.draftSource,
    manifest: s.manifest,
    draftBuild: s.draftBuild,
    publishedBuild: s.publishedBuild,
    draftUpdatedAt: s.draftUpdatedAt?.toISOString() ?? null,
  };
}

/** Concatenate a source tree into one plaintext blob for FTS / the extractor. */
export function sourceToText(src: AppSource): string {
  const paths = Object.keys(src.files).sort();
  return paths.map((p) => `// ${p}\n${src.files[p] ?? ''}`).join('\n\n');
}

async function ensureRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Apps',
      slug: APPS_ROOT_LABEL,
      path: APPS_ROOT_LABEL,
      data: { description: 'Mini apps (TSX) the Appsmith agent builds and runs in a sandbox.' },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

export type AppSort = 'edited' | 'newest' | 'oldest' | 'title';

type ListAppsOpts = { query?: string; tag?: string; sort?: AppSort };

function appOrderBy(sort?: AppSort) {
  switch (sort) {
    case 'newest':
      return desc(nodes.createdAt);
    case 'oldest':
      return asc(nodes.createdAt);
    case 'title':
      return asc(nodes.title);
    case 'edited':
    default:
      return desc(nodes.updatedAt);
  }
}

function appConds(ownerId: string, opts: ListAppsOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')];
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${apps.sourceText} ilike ${q}`,
      sql`${nodes.data}->>'summary' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  return conds;
}

export async function listApps(
  ownerId: string,
  opts: ListAppsOpts & { limit?: number; offset?: number } = {},
): Promise<AppRow[]> {
  // The active share (unique per node) + the hub designation give each row its
  // exposure badge: Hub ⊃ Team ⊃ Public ⊃ owner-only.
  //
  // Only the columns a row shows (apps audit P2): the whole node row carried
  // the embedding, and the draft column the whole draft source tree (up to
  // 50 × 256 KB per app, up to 500 apps), to answer "is there a draft".
  const [rows, prefs] = await Promise.all([
    db
      .select({
        node: {
          id: nodes.id,
          title: nodes.title,
          data: nodes.data,
          tags: nodes.tags,
          audience: nodes.audience,
          inheritedLevel: nodes.inheritedLevel,
          embeddedLevel: nodes.embeddedLevel,
          createdAt: nodes.createdAt,
          updatedAt: nodes.updatedAt,
        },
        manifest: apps.manifest,
        hasDraft: sql<boolean>`${apps.draftSource} is not null`,
        publishedBuild: apps.publishedBuild,
        dataReadOnly: apps.dataReadOnly,
        shareSettings: shares.settings,
      })
      .from(nodes)
      .leftJoin(apps, eq(apps.nodeId, nodes.id))
      .leftJoin(
        shares,
        // The open link only: an app may carry many contact shares (0214).
        and(eq(shares.nodeId, nodes.id), isNull(shares.revokedAt), isNull(shares.contactId)),
      )
      .where(and(...appConds(ownerId, opts)))
      .orderBy(appOrderBy(opts.sort))
      .limit(opts.limit ?? 500)
      .offset(opts.offset ?? 0),
    loadProfilePreferences(ownerId),
  ]);
  const hubAppId = prefs.teamHubAppId ?? null;
  return rows.map((r) =>
    rowOf(r.node, {
      manifest: r.manifest ?? {},
      hasDraft: r.hasDraft === true,
      publishedBuild: r.publishedBuild ?? null,
      shareSettings: r.shareSettings ?? null,
      hubAppId,
      dataReadOnly: r.dataReadOnly === true,
    }),
  );
}

export async function countApps(ownerId: string, opts: ListAppsOpts = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .leftJoin(apps, eq(apps.nodeId, nodes.id))
    .where(and(...appConds(ownerId, opts)));
  return row?.n ?? 0;
}

export async function listAppTags(ownerId: string): Promise<{ tag: string; count: number }[]> {
  const rows = await db
    .select({ tags: nodes.tags })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')));
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

async function loadDetail(ownerId: string, id: string): Promise<AppDetail | null> {
  const [[row], prefs] = await Promise.all([
    db
      .select({
        node: nodes,
        source: apps.source,
        draftSource: apps.draftSource,
        manifest: apps.manifest,
        draftBuild: apps.draftBuild,
        publishedBuild: apps.publishedBuild,
        dataReadOnly: apps.dataReadOnly,
        draftUpdatedAt: apps.draftUpdatedAt,
        shareSettings: shares.settings,
      })
      .from(nodes)
      .leftJoin(apps, eq(apps.nodeId, nodes.id))
      .leftJoin(
        shares,
        // The open link only: an app may carry many contact shares (0214).
        and(eq(shares.nodeId, nodes.id), isNull(shares.revokedAt), isNull(shares.contactId)),
      )
      .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')))
      .limit(1),
    loadProfilePreferences(ownerId),
  ]);
  if (!row) return null;
  return detailOf(row.node, {
    source: row.source ?? emptySource(),
    draftSource: row.draftSource ?? null,
    manifest: row.manifest ?? {},
    draftBuild: row.draftBuild ?? null,
    publishedBuild: row.publishedBuild ?? null,
    shareSettings: row.shareSettings ?? null,
    hubAppId: prefs.teamHubAppId ?? null,
    dataReadOnly: row.dataReadOnly === true,
    draftUpdatedAt: row.draftUpdatedAt ?? null,
  });
}

export async function getApp(ownerId: string, id: string): Promise<AppDetail | null> {
  return loadDetail(ownerId, id);
}

/** What RUNNING an app needs: its level, manifest and builds. */
export type AppRuntime = {
  id: string;
  title: string;
  audience: AppDetail['audience'];
  manifest: AppManifest;
  draftBuild: BuildRef | null;
  publishedBuild: BuildRef | null;
  dataReadOnly: boolean;
};

/**
 * The slim read for the brokers and frames (apps audit P1). Every
 * `host.db.query` and tool call used to load the whole app through getApp:
 * the published AND draft source (up to 50 × 256 KB each), the open share and
 * the owner's preferences, to read the manifest. One row, the columns that
 * running the app needs, nothing else.
 */
export async function getAppRuntime(ownerId: string, id: string): Promise<AppRuntime | null> {
  const [row] = await db
    .select({
      title: nodes.title,
      audience: nodes.audience,
      manifest: apps.manifest,
      draftBuild: apps.draftBuild,
      publishedBuild: apps.publishedBuild,
      dataReadOnly: apps.dataReadOnly,
    })
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')))
    .limit(1);
  if (!row) return null;
  return {
    id,
    title: row.title,
    audience: asViewerLevel(row.audience),
    manifest: row.manifest ?? {},
    draftBuild: row.draftBuild ?? null,
    publishedBuild: row.publishedBuild ?? null,
    dataReadOnly: row.dataReadOnly === true,
  };
}

/** The working tree the editor + build operate on: draft if present, else published. */
export function workingSource(app: AppDetail): AppSource {
  return app.draft ?? app.source;
}

export type CreateAppInput = {
  /** Only to bring a deleted app back with its old id (app-trash.ts). */
  id?: string;
  title: string;
  icon?: string;
  color?: AppTint;
  description?: string;
  tags?: string[];
  source?: AppSource;
};

export async function createApp(ownerId: string, input: CreateAppInput): Promise<AppDetail> {
  await ensureRoot(ownerId);
  const source = input.source ?? emptySource();
  const manifest: AppManifest = input.description ? { description: input.description } : {};
  const id = input.id ?? randomUUID();

  return db.transaction(async (tx) => {
    const [node] = await tx
      .insert(nodes)
      .values({
        id,
        ownerId,
        type: 'app',
        title: input.title.trim().slice(0, 200) || 'Untitled app',
        path: APPS_ROOT_LABEL,
        data: {
          ...(projectAppIcon(input.icon) ? { icon: projectAppIcon(input.icon) } : {}),
          ...(projectAppTint(input.color) ? { color: input.color } : {}),
        },
        tags: dedupeTags(input.tags ?? []),
      })
      .returning();
    if (!node) throw new Error('createApp: insert returned no row');
    await tx
      .insert(apps)
      .values({ nodeId: node.id, source, sourceText: sourceToText(source), manifest });
    return detailOf(node, {
      source,
      draftSource: null,
      manifest,
      draftBuild: null,
      publishedBuild: null,
      // A just-created app has no share and can't be the designated hub.
      shareSettings: null,
      hubAppId: null,
      dataReadOnly: false,
    });
  });
}

export type UpdateAppInput = Partial<{
  title: string;
  /** '' clears back to the default tile. */
  icon: string;
  /** null clears back to the neutral tint. */
  color: AppTint | null;
  tags: string[];
  /** The description (kept on the manifest); '' clears it. */
  description: string;
  /** Informational (client logins C6): members and clients only read the
   *  app's data. The owner's app update route is its one writer. */
  dataReadOnly: boolean;
}>;

export async function updateAppMeta(
  ownerId: string,
  id: string,
  input: UpdateAppInput,
): Promise<AppDetail | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')))
    .limit(1);
  if (!node) return null;
  const newData = { ...((node.data ?? {}) as Record<string, unknown>) };
  if (input.icon !== undefined) {
    const icon = projectAppIcon(input.icon);
    if (icon) newData.icon = icon;
    else delete newData.icon;
  }
  if (input.color !== undefined) {
    const color = projectAppTint(input.color);
    if (color) newData.color = color;
    else delete newData.color;
  }
  await db
    .update(nodes)
    .set({
      ...(input.title !== undefined
        ? { title: input.title.trim().slice(0, 200) || 'Untitled app' }
        : {}),
      ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
      data: newData,
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id));
  if (input.dataReadOnly !== undefined) {
    await db
      .update(apps)
      .set({ dataReadOnly: input.dataReadOnly, updatedAt: new Date() })
      .where(eq(apps.nodeId, id));
  }
  if (input.description !== undefined) {
    // On the manifest, under the row lock like every manifest write.
    const description = input.description.trim().slice(0, 2000);
    await db.transaction(async (tx) => {
      const app = await lockAppRow(tx, ownerId, id);
      if (!app) return;
      const manifest: AppManifest = { ...app.manifest };
      if (description) manifest.description = description;
      else delete manifest.description;
      await tx.update(apps).set({ manifest, updatedAt: new Date() }).where(eq(apps.nodeId, id));
    });
  }
  return loadDetail(ownerId, id);
}

// INVARIANT: `draft_build` is a build OF `draft_source`, so every writer below
// clears it. Without that, a green build outlives the source it came from and
// `publishApp` promotes the pair — shipping NEW source with an OLD bundle. The
// app then serves code that provably isn't in its own source, which reads to
// everyone (including the agent, which inspects source) as "the edit silently
// did nothing": the source is correct, the served bundle is not, and no cache
// clear or rebuild-less republish can converge them.

// CONCURRENCY (apps audit D4, D5, U1): the editor's autosave, the agent's
// file writes, the manifest setters and publish all read-modify-write one
// `apps` row, from two processes. Each takes the row lock first (lockAppRow),
// so two writes in flight cannot each keep only their own change, and a
// publish cannot clear a draft that changed after it read it.

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The app's sidecar row, locked FOR UPDATE until the transaction ends;
 *  null when the app is missing or not this owner's. */
async function lockAppRow(tx: DbTx, ownerId: string, id: string) {
  const [row] = await tx
    .select({
      source: apps.source,
      draft: apps.draftSource,
      manifest: apps.manifest,
      draftBuild: apps.draftBuild,
      draftUpdatedAt: apps.draftUpdatedAt,
      publishedBuild: apps.publishedBuild,
      restoredFromSeq: apps.restoredFromSeq,
    })
    .from(apps)
    .innerJoin(nodes, eq(nodes.id, apps.nodeId))
    .where(and(eq(apps.nodeId, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')))
    .for('update', { of: apps });
  if (!row) return null;
  return {
    source: row.source ?? emptySource(),
    draft: row.draft ?? null,
    manifest: row.manifest ?? {},
    draftBuild: row.draftBuild ?? null,
    draftUpdatedAt: row.draftUpdatedAt ?? null,
    publishedBuild: row.publishedBuild ?? null,
    restoredFromSeq: row.restoredFromSeq ?? null,
  };
}

/** The draft changed since the editor last read it (apps audit U1): an
 *  agent or another tab wrote it. Saving would silently drop that work. */
export class AppDraftConflictError extends Error {
  constructor() {
    super(
      'the draft changed since you opened it (the assistant or another window edited it). Reload to see the latest, then make your change again.',
    );
    this.name = 'AppDraftConflictError';
  }
}

/**
 * Replace the entire draft source tree (autosave). Returns false if missing,
 * else the draft's new `draftUpdatedAt`. With `baseDraftUpdatedAt` (the
 * value the editor last read, null for "no draft"), a draft changed since
 * then throws AppDraftConflictError and nothing is written. Without it the
 * write goes through as before (an older editor).
 */
export async function saveDraftSource(
  ownerId: string,
  id: string,
  source: AppSource,
  opts: { baseDraftUpdatedAt?: string | null } = {},
): Promise<false | { draftUpdatedAt: string }> {
  assertSourceWithinLimits(source);
  return db.transaction(async (tx) => {
    const app = await lockAppRow(tx, ownerId, id);
    if (!app) return false;
    if (
      opts.baseDraftUpdatedAt !== undefined &&
      (app.draftUpdatedAt?.toISOString() ?? null) !== opts.baseDraftUpdatedAt
    ) {
      throw new AppDraftConflictError();
    }
    const draftUpdatedAt = new Date();
    await tx
      .update(apps)
      .set({ draftSource: source, draftUpdatedAt, draftBuild: null })
      .where(eq(apps.nodeId, id));
    return { draftUpdatedAt: draftUpdatedAt.toISOString() };
  });
}

/** Write/replace one file in the draft (creating the draft from published if
 *  none exists yet). Returns the updated working tree, or null if missing. */
export async function writeDraftFile(
  ownerId: string,
  id: string,
  path: string,
  content: string,
): Promise<AppSource | null> {
  return db.transaction(async (tx) => {
    const app = await lockAppRow(tx, ownerId, id);
    if (!app) return null;
    const base = app.draft ?? app.source;
    const next: AppSource = { entry: base.entry, files: { ...base.files, [path]: content } };
    assertSourceWithinLimits(next);
    await tx
      .update(apps)
      .set({ draftSource: next, draftUpdatedAt: new Date(), draftBuild: null })
      .where(eq(apps.nodeId, id));
    return next;
  });
}

export class CannotDeleteEntryError extends Error {
  constructor() {
    super('writeDraftFile: cannot delete the entry file');
    this.name = 'CannotDeleteEntryError';
  }
}

export async function deleteDraftFile(
  ownerId: string,
  id: string,
  path: string,
): Promise<AppSource | null> {
  return db.transaction(async (tx) => {
    const app = await lockAppRow(tx, ownerId, id);
    if (!app) return null;
    const base = app.draft ?? app.source;
    if (path === base.entry) throw new CannotDeleteEntryError();
    const files = { ...base.files };
    delete files[path];
    const next: AppSource = { entry: base.entry, files };
    await tx
      .update(apps)
      .set({ draftSource: next, draftUpdatedAt: new Date(), draftBuild: null })
      .where(eq(apps.nodeId, id));
    return next;
  });
}

/** Shallow-merge a manifest patch (e.g. toolSlugs, sqlite, description). */
export async function setManifest(
  ownerId: string,
  id: string,
  patch: Partial<AppManifest>,
): Promise<AppManifest | null> {
  return db.transaction(async (tx) => {
    const app = await lockAppRow(tx, ownerId, id);
    if (!app) return null;
    const next: AppManifest = { ...app.manifest, ...patch };
    await tx.update(apps).set({ manifest: next, updatedAt: new Date() }).where(eq(apps.nodeId, id));
    return next;
  });
}

/**
 * Declare a new schema for an app's database: the script and the next
 * version. Returns that version, or null when the app is not this owner's.
 *
 * The next version is one past BOTH the manifest's and the database's own
 * (apps audit 2026-10-02, item 8). They drift apart: a data restore puts
 * the snapshot's version on the database, an undelete of a never-published
 * app keeps the old one. A schema at manifest + 1 that is not above the
 * database's was skipped without a word, since a version applies only when
 * it is newer than the database's. Under the app row lock, so two declares
 * at once take two versions.
 */
export async function declareAppSchema(
  ownerId: string,
  id: string,
  schemaSql: string,
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const app = await lockAppRow(tx, ownerId, id);
    if (!app) return null;
    const [reg] = await tx
      .select({ schemaVersion: appDatabases.schemaVersion })
      .from(appDatabases)
      .where(eq(appDatabases.appNodeId, id))
      .limit(1);
    const schemaVersion =
      Math.max(app.manifest.sqlite?.schemaVersion ?? 0, reg?.schemaVersion ?? 0) + 1;
    const next: AppManifest = { ...app.manifest, sqlite: { schemaSql, schemaVersion } };
    await tx.update(apps).set({ manifest: next, updatedAt: new Date() }).where(eq(apps.nodeId, id));
    return schemaVersion;
  });
}

/** Record a build of the draft (preview). A failed build still updates the ref
 *  so the agent sees the errors, but callers should keep the last green ref for
 *  rendering — they pass the ref to render; this only persists the latest.
 *
 *  `builtFrom`: the source the build compiled. Under the app row lock, a
 *  build of source that is no longer the working source is NOT recorded
 *  ('stale'): an autosave during the build cleared the build, and recording
 *  the old one after it paired new source with an old bundle, which the next
 *  publish would ship (apps audit 2026-10-02, item 10). */
export async function setDraftBuild(
  ownerId: string,
  id: string,
  build: BuildRef,
  opts: { builtFrom?: AppSource } = {},
): Promise<boolean | 'stale'> {
  const done = await db.transaction(async (tx) => {
    const app = await lockAppRow(tx, ownerId, id);
    if (!app) return false;
    if (opts.builtFrom && codeHash(app.draft ?? app.source) !== codeHash(opts.builtFrom)) {
      return 'stale' as const;
    }
    await tx
      .update(apps)
      .set({ draftBuild: build, updatedAt: new Date() })
      .where(eq(apps.nodeId, id));
    return true;
  });
  // The app list shows whether each app can be previewed.
  if (done === true) void notifyAppNavChanged(ownerId);
  return done;
}

export async function discardDraft(ownerId: string, id: string): Promise<boolean> {
  if (!(await ownsApp(ownerId, id))) return false;
  await db
    .update(apps)
    .set({ draftSource: null, draftUpdatedAt: null, draftBuild: null, restoredFromSeq: null })
    .where(eq(apps.nodeId, id));
  void notifyAppNavChanged(ownerId);
  return true;
}

export class NoGreenBuildError extends Error {
  constructor() {
    super(
      'publishApp: draft has no successful build to publish — every source edit ' +
        'clears the build, so run a build after your last edit and before publishing',
    );
    this.name = 'NoGreenBuildError';
  }
}

/**
 * Publish: promote `draft_source` → `source`, `draft_build` → `published_build`,
 * recompute `source_text`, clear the draft, bump version, fire the extractor.
 * Refuses if the draft hasn't been built green (NoGreenBuildError). Returns
 * the app's detail (unchanged when there was nothing to publish), or null if
 * the app doesn't exist.
 *
 * It ships the staged draft — or, when nothing is staged, a REBUILD of what is
 * already published.
 *
 * That second case is not a nicety. `app_build` compiles `draft ?? source`, so
 * building an app with no draft produces a green build OF THE PUBLISHED SOURCE.
 * Gating publish on the draft SOURCE left that build unpromotable: an app whose
 * code has not changed but whose BUNDLE is stale had no path to a fresh one
 * short of rewriting its own source back over itself.
 *
 * Which stopped being hypothetical the day per-app Tailwind CSS shipped
 * (v0.230.57). Every app built before it carries a bundle with no CSS sidecar,
 * the frame serves `appCss` from that sidecar, and so every app on every box
 * rolled past that release renders with NO STYLESHEET until it is rebuilt. The
 * repair is a rebuild, and the rebuild could not be published. Any future change
 * to what a build EMITS — a source map, a second sidecar — strands every
 * existing app the same way, so the gate belongs on the build, not the source.
 *
 * Safe because the two cases write different things: with a draft, source and
 * bundle are promoted TOGETHER (they were built as a pair); without one, only
 * the bundle moves and the source it was built from is already published. The
 * pairing invariant that `apps-build-staleness.test.ts` guards — never ship new
 * source beside an old bundle — is untouched in both.
 */
/** Who published, and why (the version row's actor and note). */
export type PublishAppOpts = { note?: string | null; actor?: AppHistoryActor };

/** Who wrote a version or snapshot row. */
export type AppHistoryActor = 'owner' | 'agent' | 'mcp' | 'system';

export async function publishApp(
  ownerId: string,
  id: string,
  opts: PublishAppOpts = {},
): Promise<AppDetail | null> {
  // Under the row lock (apps audit D4): an autosave that lands while this
  // runs waits for it and becomes the next draft, and one that landed before
  // is what is read here (and it cleared the build, so the publish refuses
  // rather than shipping the old build as the new source).
  const published = await db.transaction(async (tx) => {
    const app = await lockAppRow(tx, ownerId, id);
    if (!app) return null;
    // Nothing staged and no rebuild waiting — already published.
    if (!app.draft && !app.draftBuild) return false;
    if (!app.draftBuild?.ok) throw new NoGreenBuildError();
    await promote(tx, id, app.draft, app.draftBuild);
    // The version this publish makes (apps snapshots, Phase 2): the code
    // that just went live, appended in the same transaction.
    const code = {
      source: app.draft ?? app.source,
      draft: null,
      manifest: app.manifest,
      publishedBuild: app.draftBuild,
    };
    await insertNodeSnapshot(tx, {
      ownerId,
      nodeId: id,
      nodeKind: 'app',
      trigger: 'publish',
      note: opts.note?.trim().slice(0, 500) || null,
      actor: opts.actor ?? 'owner',
      code,
      sourceHash: codeHash(code.source),
      restoredFrom: app.restoredFromSeq,
    });
    return true;
  });
  if (published === null) return null;
  if (published) {
    await notifyNodeIngested(id);
    void notifyAppNavChanged(ownerId);
  }
  return loadDetail(ownerId, id);
}

/** The publish write itself: the staged draft (when there is one) and the
 *  build validated from it, promoted together. */
async function promote(
  tx: DbTx,
  id: string,
  published: AppSource | null,
  build: BuildRef,
): Promise<void> {
  // Only when a draft is actually staged. A build-only publish must not touch
  // the source — it was built from what is already there. Hoisted out of the
  // `.set({…})` rather than spread inline: the staleness tripwire parses those
  // payloads with a non-greedy match, and a nested `})` truncates what it sees.
  const sourceFields = published ? { source: published, sourceText: sourceToText(published) } : {};
  await tx
    .update(apps)
    .set({
      ...sourceFields,
      publishedBuild: build,
      draftSource: null,
      draftUpdatedAt: null,
      draftBuild: null,
      restoredFromSeq: null,
      version: sql`${apps.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(apps.nodeId, id));
  await tx.update(nodes).set({ embedding: null, updatedAt: new Date() }).where(eq(nodes.id, id));
}

/** The draft holds unpublished work, and a restore into it would drop that
 *  work: the caller must say to discard it. */
export class AppRestoreDraftError extends Error {
  constructor() {
    super(
      'the app has an unpublished draft, and restoring code replaces it: pass discard_draft (or confirm in the editor) to drop the draft, or commit it first',
    );
    this.name = 'AppRestoreDraftError';
  }
}

/** A snapshot's code, as restore takes it. */
type RestorableCode = {
  source: AppSource;
  draft: AppSource | null;
  manifest: AppManifest;
  publishedBuild: BuildRef | null;
};

/**
 * Code-only restore (apps snapshots, Phase 2): the snapshot's code goes into
 * the DRAFT, never straight to live. The editor then previews and commits it
 * as usual, and that publish becomes a new version "restored from v{seq}".
 * The manifest does not change: the app has ONE allowlist, the live app's,
 * so restoring the old tools with the draft granted them to the live app at
 * once (apps audit 2026-10-02, item 9). The caller names them instead; the
 * owner grants them with app_tools_set. The declared SQLite schema stays too
 * (it belongs to the live data).
 */
export async function restoreAppDraft(
  ownerId: string,
  id: string,
  code: RestorableCode,
  seq: number,
  opts: { discardDraft?: boolean } = {},
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const app = await lockAppRow(tx, ownerId, id);
    if (!app) return false;
    if (app.draft && !opts.discardDraft) throw new AppRestoreDraftError();
    await tx
      .update(apps)
      .set({
        draftSource: code.draft ?? code.source,
        draftUpdatedAt: new Date(),
        draftBuild: null,
        restoredFromSeq: seq,
        updatedAt: new Date(),
      })
      .where(eq(apps.nodeId, id));
    return true;
  });
}

/**
 * Full rollback (apps snapshots, Phase 2): the snapshot's code goes LIVE with
 * the build it ran on, together with its declared schema, because that code
 * and the data restored beside it were known to work together. A draft the
 * snapshot held comes back as the draft (no build: build it to preview).
 * Appends the version "restored from v{seq}". The data half is
 * restoreAppDatabaseFile's.
 */
export async function restoreAppLive(
  ownerId: string,
  id: string,
  code: RestorableCode & { publishedBuild: BuildRef },
  seq: number,
  opts: { discardDraft?: boolean; actor?: AppHistoryActor } = {},
): Promise<boolean> {
  const done = await db.transaction(async (tx) => {
    const app = await lockAppRow(tx, ownerId, id);
    if (!app) return false;
    if (app.draft && !opts.discardDraft) throw new AppRestoreDraftError();
    await tx
      .update(apps)
      .set({
        source: code.source,
        sourceText: sourceToText(code.source),
        publishedBuild: code.publishedBuild,
        manifest: code.manifest,
        draftSource: code.draft,
        draftUpdatedAt: code.draft ? new Date() : null,
        draftBuild: null,
        restoredFromSeq: null,
        version: sql`${apps.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(apps.nodeId, id));
    await tx.update(nodes).set({ embedding: null, updatedAt: new Date() }).where(eq(nodes.id, id));
    const live = {
      source: code.source,
      draft: null,
      manifest: code.manifest,
      publishedBuild: code.publishedBuild,
    };
    await insertNodeSnapshot(tx, {
      ownerId,
      nodeId: id,
      nodeKind: 'app',
      trigger: 'publish',
      note: `restored v${seq}`,
      actor: opts.actor ?? 'owner',
      code: live,
      sourceHash: codeHash(code.source),
      restoredFrom: seq,
    });
    return true;
  });
  if (done) {
    await notifyNodeIngested(id);
    void notifyAppNavChanged(ownerId);
  }
  return done;
}

/** The code a duplicate carries over: both trees, each with its build. */
export type InstallableAppCode = RestorableCode & { draftBuild: BuildRef | null };

/**
 * Give a just-created app another app's code (a duplicate, app-package.ts):
 * the published source with the build it runs on, the draft with its preview
 * build, and the manifest. Builds are content-addressed objects in this
 * brain's store, so a pair that was valid there is valid here. A published
 * build becomes the copy's first version, noted `opts.note`.
 */
export async function installAppCode(
  ownerId: string,
  id: string,
  code: InstallableAppCode,
  opts: { note: string; actor?: AppHistoryActor },
): Promise<boolean> {
  const live = code.publishedBuild?.ok ? code.publishedBuild : null;
  const done = await db.transaction(async (tx) => {
    const app = await lockAppRow(tx, ownerId, id);
    if (!app) return false;
    await tx
      .update(apps)
      .set({
        source: code.source,
        sourceText: sourceToText(code.source),
        publishedBuild: live,
        manifest: code.manifest,
        draftSource: code.draft,
        draftUpdatedAt: code.draft ? new Date() : null,
        draftBuild: code.draftBuild,
        updatedAt: new Date(),
      })
      .where(eq(apps.nodeId, id));
    if (live) {
      await insertNodeSnapshot(tx, {
        ownerId,
        nodeId: id,
        nodeKind: 'app',
        trigger: 'publish',
        note: opts.note.slice(0, 500),
        actor: opts.actor ?? 'owner',
        code: { source: code.source, draft: null, manifest: code.manifest, publishedBuild: live },
        sourceHash: codeHash(code.source),
      });
    }
    return true;
  });
  if (done && live) await notifyNodeIngested(id);
  return done;
}

/**
 * Delete an app. A `pre_delete` snapshot comes first (the code, the name and
 * look, and a copy of the database), and the app's history outlives it, so
 * for 30 days the app can come back from Recently deleted (app-trash.ts).
 * When that snapshot cannot be taken the app is NOT deleted. An app whose
 * database file was already lost keeps a code-only snapshot.
 */
export async function deleteApp(
  ownerId: string,
  id: string,
  opts: { actor?: AppHistoryActor } = {},
): Promise<boolean> {
  if (!(await ownsApp(ownerId, id))) return false;
  // Dynamic imports keep the server-only modules (node:fs, sqlite) out of the
  // content index / edge bundles.
  const broker = await import('./app-broker');
  const { createAppSnapshot } = await import('./app-snapshots');
  const keep = {
    trigger: 'pre_delete' as const,
    actor: opts.actor ?? 'owner',
    note: 'before delete',
  };
  await createAppSnapshot(ownerId, id, { ...keep, codeOnlyWhenLost: true });
  // The node goes first, then the live database file (apps audit D6). Its
  // path is read now: the `app_databases` row cascades away with the node.
  // The snapshot files stay, with the history rows, for the trash.
  const dbPath = await broker.appDatabasePath(ownerId, id);
  await db.delete(nodes).where(eq(nodes.id, id)); // `apps` + `app_databases` cascade.
  if (dbPath) {
    try {
      await broker.removeAppDatabaseFiles(dbPath);
    } catch (err) {
      // The app is gone either way; a stray file is only disk.
      console.error(`[apps] app ${id} deleted, but its database file stayed:`, err);
    }
  }
  return true;
}

async function ownsApp(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')))
    .limit(1);
  return !!row;
}

function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t || t.length > 40 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}
