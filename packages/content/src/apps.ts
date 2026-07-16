/**
 * Apps surface. An app is a `nodes` row with type='app' plus an `apps` sidecar
 * holding the source virtual file tree, the manifest, and build-artifact
 * pointers:
 *
 *   nodes.title           display name
 *   nodes.data.icon       optional emoji / icon
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
  db,
  nodes,
  apps,
  shares,
  notifyNodeIngested,
  type Node,
  type AppSource,
  type AppManifest,
  type BuildRef,
} from '@mantle/db';
import { shareModeOf, type ShareMode } from './shares';
import { loadProfilePreferences } from './profile-preferences';

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

export type AppRow = {
  id: string;
  title: string;
  icon: string | null;
  tags: string[];
  summary: string | null;
  description: string | null;
  /** Number of declared api_tool slugs. */
  toolCount: number;
  /** Whether the published source has a green build (renders today). */
  hasBuild: boolean;
  /** Whether an uncommitted draft exists. */
  hasDraft: boolean;
  /**
   * The app's exposure: mode of its active share ('public' | 'team'), or null
   * when it has never been shared / the share is revoked (owner-only).
   */
  shareMode: ShareMode | null;
  /** Whether this app is the designated Team Hub (prefs.teamHubAppId). */
  isHub: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AppDetail = AppRow & {
  source: AppSource;
  draft: AppSource | null;
  manifest: AppManifest;
  draftBuild: BuildRef | null;
  publishedBuild: BuildRef | null;
};

type SidecarCols = {
  source: AppSource;
  draftSource: AppSource | null;
  manifest: AppManifest;
  draftBuild: BuildRef | null;
  publishedBuild: BuildRef | null;
  /** settings of the node's ACTIVE share, null when unshared/revoked. */
  shareSettings: Record<string, unknown> | null;
  /** prefs.teamHubAppId — resolved once per query, compared per row. */
  hubAppId: string | null;
};

function rowOf(n: Node, s: Partial<SidecarCols> = {}): AppRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const manifest = (s.manifest ?? {}) as AppManifest;
  return {
    id: n.id,
    title: n.title,
    icon: typeof d.icon === 'string' ? d.icon : null,
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    description: typeof manifest.description === 'string' ? manifest.description : null,
    toolCount: manifest.toolSlugs?.length ?? 0,
    hasBuild: !!s.publishedBuild?.ok,
    hasDraft: s.draftSource != null,
    shareMode: s.shareSettings ? shareModeOf({ settings: s.shareSettings }) : null,
    isHub: s.hubAppId != null && s.hubAppId === n.id,
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
  const [rows, prefs] = await Promise.all([
    db
      .select({
        node: nodes,
        manifest: apps.manifest,
        draftSource: apps.draftSource,
        publishedBuild: apps.publishedBuild,
        shareSettings: shares.settings,
      })
      .from(nodes)
      .leftJoin(apps, eq(apps.nodeId, nodes.id))
      .leftJoin(shares, and(eq(shares.nodeId, nodes.id), isNull(shares.revokedAt)))
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
      draftSource: r.draftSource ?? null,
      publishedBuild: r.publishedBuild ?? null,
      shareSettings: r.shareSettings ?? null,
      hubAppId,
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
        shareSettings: shares.settings,
      })
      .from(nodes)
      .leftJoin(apps, eq(apps.nodeId, nodes.id))
      .leftJoin(shares, and(eq(shares.nodeId, nodes.id), isNull(shares.revokedAt)))
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
  });
}

export async function getApp(ownerId: string, id: string): Promise<AppDetail | null> {
  return loadDetail(ownerId, id);
}

/** The working tree the editor + build operate on: draft if present, else published. */
export function workingSource(app: AppDetail): AppSource {
  return app.draft ?? app.source;
}

export type CreateAppInput = {
  title: string;
  icon?: string;
  description?: string;
  tags?: string[];
  source?: AppSource;
};

export async function createApp(ownerId: string, input: CreateAppInput): Promise<AppDetail> {
  await ensureRoot(ownerId);
  const source = input.source ?? emptySource();
  const manifest: AppManifest = input.description ? { description: input.description } : {};
  const id = randomUUID();

  return db.transaction(async (tx) => {
    const [node] = await tx
      .insert(nodes)
      .values({
        id,
        ownerId,
        type: 'app',
        title: input.title.trim().slice(0, 200) || 'Untitled app',
        path: APPS_ROOT_LABEL,
        data: { ...(input.icon ? { icon: input.icon } : {}) },
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
    });
  });
}

export type UpdateAppInput = Partial<{
  title: string;
  icon: string;
  tags: string[];
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
  if (input.icon !== undefined) newData.icon = input.icon;
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
  return loadDetail(ownerId, id);
}

/** Replace the entire draft source tree (autosave). Returns false if missing. */
export async function saveDraftSource(
  ownerId: string,
  id: string,
  source: AppSource,
): Promise<boolean> {
  if (!(await ownsApp(ownerId, id))) return false;
  assertSourceWithinLimits(source);
  await db
    .update(apps)
    .set({ draftSource: source, draftUpdatedAt: new Date() })
    .where(eq(apps.nodeId, id));
  return true;
}

/** Write/replace one file in the draft (creating the draft from published if
 *  none exists yet). Returns the updated working tree, or null if missing. */
export async function writeDraftFile(
  ownerId: string,
  id: string,
  path: string,
  content: string,
): Promise<AppSource | null> {
  const app = await loadDetail(ownerId, id);
  if (!app) return null;
  const base = workingSource(app);
  const next: AppSource = { entry: base.entry, files: { ...base.files, [path]: content } };
  assertSourceWithinLimits(next);
  await db
    .update(apps)
    .set({ draftSource: next, draftUpdatedAt: new Date() })
    .where(eq(apps.nodeId, id));
  return next;
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
  const app = await loadDetail(ownerId, id);
  if (!app) return null;
  const base = workingSource(app);
  if (path === base.entry) throw new CannotDeleteEntryError();
  const files = { ...base.files };
  delete files[path];
  const next: AppSource = { entry: base.entry, files };
  await db
    .update(apps)
    .set({ draftSource: next, draftUpdatedAt: new Date() })
    .where(eq(apps.nodeId, id));
  return next;
}

/** Shallow-merge a manifest patch (e.g. toolSlugs, sqlite, description). */
export async function setManifest(
  ownerId: string,
  id: string,
  patch: Partial<AppManifest>,
): Promise<AppManifest | null> {
  const app = await loadDetail(ownerId, id);
  if (!app) return null;
  const next: AppManifest = { ...app.manifest, ...patch };
  await db.update(apps).set({ manifest: next, updatedAt: new Date() }).where(eq(apps.nodeId, id));
  return next;
}

/** Record a build of the draft (preview). A failed build still updates the ref
 *  so the agent sees the errors, but callers should keep the last green ref for
 *  rendering — they pass the ref to render; this only persists the latest. */
export async function setDraftBuild(
  ownerId: string,
  id: string,
  build: BuildRef,
): Promise<boolean> {
  if (!(await ownsApp(ownerId, id))) return false;
  await db
    .update(apps)
    .set({ draftBuild: build, updatedAt: new Date() })
    .where(eq(apps.nodeId, id));
  return true;
}

export async function discardDraft(ownerId: string, id: string): Promise<boolean> {
  if (!(await ownsApp(ownerId, id))) return false;
  await db
    .update(apps)
    .set({ draftSource: null, draftUpdatedAt: null, draftBuild: null })
    .where(eq(apps.nodeId, id));
  return true;
}

export class NoGreenBuildError extends Error {
  constructor() {
    super('publishApp: draft has no successful build to publish');
    this.name = 'NoGreenBuildError';
  }
}

/**
 * Publish: promote `draft_source` → `source`, `draft_build` → `published_build`,
 * recompute `source_text`, clear the draft, bump version, fire the extractor.
 * Refuses if the draft hasn't been built green. Returns the published detail, or
 * null if the app doesn't exist (or has nothing to publish).
 */
export async function publishApp(ownerId: string, id: string): Promise<AppDetail | null> {
  const app = await loadDetail(ownerId, id);
  if (!app) return null;
  if (!app.draft) return app; // nothing staged — already published
  if (!app.draftBuild?.ok) throw new NoGreenBuildError();

  const published = app.draft;
  const build = app.draftBuild;
  await db.transaction(async (tx) => {
    await tx
      .update(apps)
      .set({
        source: published,
        sourceText: sourceToText(published),
        publishedBuild: build,
        draftSource: null,
        draftUpdatedAt: null,
        draftBuild: null,
        version: sql`${apps.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(apps.nodeId, id));
    await tx.update(nodes).set({ embedding: null, updatedAt: new Date() }).where(eq(nodes.id, id));
  });
  await notifyNodeIngested(id);
  return loadDetail(ownerId, id);
}

export async function deleteApp(ownerId: string, id: string): Promise<boolean> {
  if (!(await ownsApp(ownerId, id))) return false;
  // Remove the per-app SQLite file BEFORE the node delete cascades the
  // `app_databases` row away (we resolve the path from that row). Best-effort:
  // a stray file must not block the delete. Dynamic import keeps the server-only
  // broker (node:fs/sqlite) out of the content index / edge bundles.
  try {
    const { deleteAppDatabaseFile } = await import('./app-broker');
    await deleteAppDatabaseFile(ownerId, id);
  } catch {
    /* best-effort file cleanup; the DB rows still cascade below */
  }
  await db.delete(nodes).where(eq(nodes.id, id)); // `apps` + `app_databases` cascade.
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
