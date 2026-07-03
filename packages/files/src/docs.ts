/**
 * Documentation sync: markdown files on disk → `type='documentation'` nodes,
 * indexed by the brain. The git-followable twin of the host-mirrored files
 * layer — but DB-only one-way (disk → DB): docs are authored in git / baked
 * into the prod image, never written back from the app.
 *
 * Tree model:
 *   - `documentation` is the root ltree label (DB-only; NOT host-mirrored, so
 *     `isFilesPath` deliberately doesn't match it and the disk helpers in
 *     ./disk.ts never touch it).
 *   - A collection (`doc_collections` row) is the opt-in unit. The sync worker
 *     only reconciles + watches ENABLED collections. The `system` collection
 *     (the repo's own docs/) ships disabled.
 *   - One node per markdown file. `data.rel_path` is the collection-relative
 *     path (e.g. `future/x.md`) and is the stable identity within a collection.
 *
 * Change detection is two cheap layers, both reused from the files layer:
 *   - file-level: `data.sha256` vs disk sha → unchanged files no-op.
 *   - chunk-level: the extractor's embedding cache makes unchanged chunks free
 *     on re-extract, so editing one paragraph of a 90KB doc costs O(delta).
 */

import { createHash } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { and, db, docCollections, eq, notifyNodeIngested, nodes, sql } from '@mantle/db';
import type { DocBrainDepth, DocCollection } from '@mantle/db';
import { dashToLtree, ltreeToDash } from './slug';

/** The single ltree label that roots the documentation subtree. */
export const DOCS_ROOT_LABEL = 'documentation';

/** Default docs root when MANTLE_DOCS_ROOT isn't set (cwd-relative, like the
 *  files root). Prod sets an absolute MANTLE_DOCS_ROOT (=/app/docs). */
const DEFAULT_DOCS_ROOT = './docs';

let warnedUnset = false;

/** Read MANTLE_DOCS_ROOT, normalised to an absolute path. Same split-brain
 *  caveat as `filesRoot()`: the cwd-relative default resolves differently per
 *  process, so set an absolute path in .env.local / compose. */
export function docsRoot(): string {
  const env = process.env.MANTLE_DOCS_ROOT?.trim();
  if (!env && !warnedUnset) {
    warnedUnset = true;
    console.warn(
      '[docs] MANTLE_DOCS_ROOT is not set — falling back to the cwd-relative ' +
        `'${DEFAULT_DOCS_ROOT}'. Set an absolute path shared by every process.`,
    );
  }
  return path.resolve(env || DEFAULT_DOCS_ROOT);
}

/**
 * The effective brain depth for a node. Documentation defaults to
 * retrieval-only (L5 index, no L4 facts/entities/graph) unless its collection
 * is explicitly 'full'; every other node type is always 'full'. Pure — the
 * extractor calls this to decide whether to run the L4 passes.
 */
export function effectiveBrainDepth(nodeType: string, rawDepth: unknown): DocBrainDepth {
  if (nodeType === 'documentation' && rawDepth !== 'full') return 'retrieval';
  return 'full';
}

/**
 * The disk root for a collection. Three cases, chosen for dev→prod portability
 * (the `doc_collections` row travels via `pg_dump`, so a machine-specific
 * absolute path would resolve wrong on the other box):
 *   - null `root_path`     → the global docs root (`MANTLE_DOCS_ROOT`). The
 *                            `system` collection. Per-env via the env var.
 *   - relative `root_path` → resolved against the docs root, e.g. `'guide'` →
 *                            `<docsRoot>/guide`. PORTABLE — the right shape for
 *                            repo-shipped content baked into the image. (Note:
 *                            do NOT resolve relative paths against cwd — every
 *                            Mantle process runs with cwd `apps/web`, so a bare
 *                            relative path would land under apps/web, not docs.)
 *   - absolute `root_path` → used as-is, for an external dir (e.g. an Obsidian
 *                            vault). Machine-specific by definition; not portable.
 */
export function collectionRoot(collection: Pick<DocCollection, 'rootPath'>): string {
  const rp = collection.rootPath;
  if (!rp) return docsRoot();
  if (path.isAbsolute(rp)) return path.resolve(rp);
  return path.resolve(docsRoot(), rp);
}

/**
 * Reverse-map an absolute markdown path under a collection root to its ltree
 * location + collection-relative path. Returns null when the path escapes the
 * root (traversal guard, like `ltreeForDiskPath`).
 *
 *   <root>/architecture.md        → { parentPath: 'documentation', filename: 'architecture.md', relPath: 'architecture.md' }
 *   <root>/future/x.md            → { parentPath: 'documentation.future', filename: 'x.md', relPath: 'future/x.md' }
 */
export function ltreeForDocPath(
  absPath: string,
  root: string,
): { parentPath: string; filename: string; relPath: string } | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(absPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null;
  const rel = path.relative(resolvedRoot, resolved);
  if (!rel || rel.startsWith('..')) return null;
  const relPath = rel.split(path.sep).join('/');
  const parts = rel.split(path.sep);
  const filename = parts.pop();
  if (!filename) return null;
  const segments = parts.map(dashToLtree);
  const parentPath = segments.length === 0
    ? DOCS_ROOT_LABEL
    : `${DOCS_ROOT_LABEL}.${segments.join('.')}`;
  return { parentPath, filename, relPath };
}

/** Lazy-create the `documentation` root + intermediate branch nodes so the
 *  tree is navigable. DB-only — no disk mkdir (mirrors `ensureBranchChain` but
 *  rooted at `documentation`). */
async function ensureDocBranchChain(ownerId: string, ltreePath: string): Promise<void> {
  if (ltreePath !== DOCS_ROOT_LABEL && !ltreePath.startsWith(`${DOCS_ROOT_LABEL}.`)) return;
  const segments = ltreePath.split('.');
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('.');
    const label = segments[i - 1]!;
    const slug = ltreeToDash(label);
    await db
      .insert(nodes)
      .values({
        ownerId,
        type: 'branch',
        title: i === 1 ? 'Documentation' : slug,
        slug: null,
        path: prefix,
        data: { description: '', slug },
      })
      .onConflictDoNothing({
        target: [nodes.ownerId, nodes.path],
        where: sql`${nodes.type} = 'branch'`,
      });
  }
}

/** A doc the reconcile pass read off disk. */
export type DiskDoc = { relPath: string; bytes: Buffer; sha256: string };

/**
 * Sync one markdown file from disk into a `documentation` node. The workhorse,
 * modelled on `syncFileFromDisk`: file-level sha gate, embedding nulled on
 * change, explicit notify on UPDATE (INSERT auto-fires the 0018 trigger).
 *
 * Identity is `(ownerId, type='documentation', data.collection, data.rel_path)`
 * — unambiguous within a collection regardless of nesting.
 */
export async function upsertDocFromDisk(args: {
  ownerId: string;
  collection: DocCollection;
  relPath: string;
  bytes: Buffer;
}): Promise<{ status: 'noop' | 'inserted' | 'updated'; nodeId: string | null }> {
  const { ownerId, collection } = args;
  const root = collectionRoot(collection);
  const abs = path.join(root, args.relPath);
  const loc = ltreeForDocPath(abs, root);
  if (!loc) throw new Error(`upsertDocFromDisk: '${args.relPath}' escapes the collection root`);

  const sha256 = createHash('sha256').update(args.bytes).digest('hex');
  const content = args.bytes.toString('utf8');

  const newData: Record<string, unknown> = {
    origin: collection.origin,
    collection: collection.key,
    brain_depth: collection.brainDepth,
    filename: loc.filename,
    rel_path: loc.relPath,
    extension: 'md',
    mime_type: 'text/markdown; charset=utf-8',
    size_bytes: args.bytes.byteLength,
    sha256,
    content,
  };

  const [existing] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'documentation'),
        sql`${nodes.data}->>'collection' = ${collection.key}`,
        sql`${nodes.data}->>'rel_path' = ${loc.relPath}`,
      ),
    )
    .limit(1);

  if (existing) {
    const oldData = (existing.data ?? {}) as Record<string, unknown>;
    if (oldData.sha256 === sha256) return { status: 'noop', nodeId: existing.id };
    const [updated] = await db
      .update(nodes)
      .set({ title: loc.relPath, data: newData, updatedAt: new Date(), embedding: null })
      .where(eq(nodes.id, existing.id))
      .returning({ id: nodes.id });
    if (!updated) throw new Error('upsertDocFromDisk: update returned no row');
    await notifyNodeIngested(updated.id);
    return { status: 'updated', nodeId: updated.id };
  }

  await ensureDocBranchChain(ownerId, loc.parentPath);
  const [inserted] = await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'documentation',
      title: loc.relPath,
      slug: null,
      path: loc.parentPath,
      data: newData,
      tags: ['documentation', collection.origin],
    })
    .returning({ id: nodes.id });
  if (!inserted) throw new Error('upsertDocFromDisk: insert returned no row');
  // INSERT of a non-branch node auto-fires node_ingested (migration 0018).
  return { status: 'inserted', nodeId: inserted.id };
}

/** Delete a documentation node by its collection + relative path. */
export async function deleteDocByRelPath(args: {
  ownerId: string;
  collection: string;
  relPath: string;
}): Promise<{ ok: boolean }> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'documentation'),
        sql`${nodes.data}->>'collection' = ${args.collection}`,
        sql`${nodes.data}->>'rel_path' = ${args.relPath}`,
      ),
    )
    .limit(1);
  if (!node) return { ok: false };
  await db.delete(nodes).where(eq(nodes.id, node.id)); // content_chunks cascade via FK
  return { ok: true };
}

/**
 * Pure diff: classify disk vs DB by sha. `toUpsert` = new or changed files;
 * `toDelete` = DB docs whose file is gone. Empty-root SAFETY GUARD: when the
 * disk set is empty (missing / misconfigured root), never delete — a blank
 * MANTLE_DOCS_ROOT must not wipe an indexed collection.
 */
export function diffDocSets(
  disk: Record<string, string>,
  dbShas: Record<string, string>,
): { toUpsert: string[]; toDelete: string[] } {
  const diskKeys = Object.keys(disk);
  const toUpsert = diskKeys.filter((k) => dbShas[k] !== disk[k]);
  const toDelete = diskKeys.length === 0 ? [] : Object.keys(dbShas).filter((k) => !(k in disk));
  return { toUpsert, toDelete };
}

/** Markdown filename matcher — shared by the walker, listing, and read guard. */
const MARKDOWN_RE = /\.(md|markdown)$/i;

/** A path segment is "hidden" when it starts with `.` (dotfiles, as always) or
 *  `_` — the convention for docs kept on disk but excluded from BOTH the reader
 *  and brain indexing (e.g. `docs/_archive/` for stale handoffs/retrospectives). */
function isHiddenSegment(name: string): boolean {
  return name.startsWith('.') || name.startsWith('_');
}

/** True when any segment of a collection-relative path is hidden (`.`/`_`-prefixed).
 *  The walker already drops these from listings; this guards direct deep-link reads
 *  so a crafted `/docs/<col>/_archive/x.md` URL can't render a hidden doc. */
export function isHiddenDocRelPath(relPath: string): boolean {
  return relPath.split('/').some(isHiddenSegment);
}

/** Recursively collect collection-relative `*.md` paths under a root, skipping
 *  hidden (`.`/`_`-prefixed) files and dirs. Returns `[]` when the root is missing
 *  (ENOENT). The shared traversal behind `walkMarkdown` and `listMarkdownRelPaths`,
 *  so `_`-folders drop out of nav, listing, and indexing at once. */
async function walkMarkdownRelPaths(root: string): Promise<string[]> {
  const out: string[] = [];
  const resolvedRoot = path.resolve(root);
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (isHiddenSegment(entry.name)) continue; // .dotfiles + _archive et al.
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && MARKDOWN_RE.test(entry.name)) {
        out.push(path.relative(resolvedRoot, abs).split(path.sep).join('/'));
      }
    }
  }
  await walk(resolvedRoot);
  return out;
}

/** Recursively collect `*.md` files under a root (skipping dotfiles/dirs),
 *  reading bytes + sha for each. Used by the indexer (reconcileCollection). */
async function walkMarkdown(root: string): Promise<DiskDoc[]> {
  const resolvedRoot = path.resolve(root);
  const relPaths = await walkMarkdownRelPaths(resolvedRoot);
  const out: DiskDoc[] = [];
  for (const relPath of relPaths) {
    const bytes = await fs.readFile(path.join(resolvedRoot, relPath));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    out.push({ relPath, bytes, sha256 });
  }
  return out;
}

/**
 * List a collection's markdown files (collection-relative paths), sorted. DB-free
 * — the disk-backed `/docs` reader's nav source, so docs are browsable whether or
 * not the collection is indexed. `[]` if the root is missing.
 */
export async function listMarkdownRelPaths(root: string): Promise<string[]> {
  return (await walkMarkdownRelPaths(root)).sort();
}

/**
 * Read one markdown file by collection-relative path, DB-free. Validates the path
 * with `ltreeForDocPath` (rejects `..` traversal escapes) AND the `.md` extension,
 * so a crafted relPath can't read outside the root or a non-markdown file. Returns
 * the UTF-8 content, or `null` when missing / invalid (the reader 404s on null).
 */
export async function readMarkdownFile(root: string, relPath: string): Promise<string | null> {
  const resolvedRoot = path.resolve(root);
  const abs = path.join(resolvedRoot, relPath);
  if (!ltreeForDocPath(abs, resolvedRoot)) return null; // escapes the root
  if (!MARKDOWN_RE.test(abs)) return null; // non-markdown
  try {
    return await fs.readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export type ReconcileResult = {
  inserted: number;
  updated: number;
  noop: number;
  deleted: number;
};

/**
 * Reconcile one collection: walk its root, upsert changed/new docs, delete
 * docs whose file is gone. The boot-time pass the files-watcher lacks — and in
 * prod (immutable docs) the ONLY indexing path. Skips deletion on an empty
 * walk (the safety guard).
 */
export async function reconcileCollection(
  ownerId: string,
  collection: DocCollection,
): Promise<ReconcileResult> {
  const root = collectionRoot(collection);
  const diskDocs = await walkMarkdown(root);
  const disk: Record<string, string> = {};
  const bytesByRel = new Map<string, Buffer>();
  for (const d of diskDocs) {
    disk[d.relPath] = d.sha256;
    bytesByRel.set(d.relPath, d.bytes);
  }

  const dbRows = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'documentation'),
        sql`${nodes.data}->>'collection' = ${collection.key}`,
      ),
    );
  const dbShas: Record<string, string> = {};
  for (const row of dbRows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const rel = data.rel_path as string | undefined;
    if (rel) dbShas[rel] = (data.sha256 as string | undefined) ?? '';
  }

  if (diskDocs.length === 0) {
    console.warn(
      `[docs] reconcile '${collection.key}': 0 markdown files under ${root} — ` +
        'skipping deletion pass (empty/misconfigured root guard).',
    );
  }

  const { toUpsert, toDelete } = diffDocSets(disk, dbShas);
  let inserted = 0;
  let updated = 0;
  for (const relPath of toUpsert) {
    const bytes = bytesByRel.get(relPath)!;
    const res = await upsertDocFromDisk({ ownerId, collection, relPath, bytes });
    if (res.status === 'inserted') inserted++;
    else if (res.status === 'updated') updated++;
  }
  let deleted = 0;
  for (const relPath of toDelete) {
    const res = await deleteDocByRelPath({ ownerId, collection: collection.key, relPath });
    if (res.ok) deleted++;
  }

  await db
    .update(docCollections)
    .set({ lastReconciledAt: new Date(), updatedAt: new Date() })
    .where(eq(docCollections.id, collection.id));

  return { inserted, updated, noop: diskDocs.length - toUpsert.length, deleted };
}

/** Reconcile every enabled collection for the owner. The worker boot entrypoint. */
export async function reconcileEnabledCollections(ownerId: string): Promise<void> {
  const cols = await db
    .select()
    .from(docCollections)
    .where(and(eq(docCollections.ownerId, ownerId), eq(docCollections.enabled, true)));
  for (const col of cols) {
    const res = await reconcileCollection(ownerId, col);
    console.log(`[docs] reconcile '${col.key}'`, res);
  }
}

/** Hard-delete every documentation node in a collection (chunks cascade). Run
 *  when a collection is disabled. */
export async function purgeCollection(ownerId: string, collectionKey: string): Promise<number> {
  const deleted = await db
    .delete(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'documentation'),
        sql`${nodes.data}->>'collection' = ${collectionKey}`,
      ),
    )
    .returning({ id: nodes.id });
  return deleted.length;
}

// ── Collection registry ──────────────────────────────────────────────────────

/**
 * Built-in collections that ship with every install (disabled by default — the
 * block is always present to toggle, but nothing indexes until the operator opts
 * in). `rootPath: null` ⇒ the global docs root (MANTLE_DOCS_ROOT); a relative
 * rootPath resolves under it (see `collectionRoot`).
 *   - `system` — the repo's own deep developer docs (all of docs/).
 *   - `guide`  — the user-facing **User Guide** (docs/guide/), shipped in the repo.
 *   - `changelog` — the per-release notes (docs/_changelog/). Rooting a collection
 *     AT a `_`-dir is the deliberate escape hatch from the hidden convention:
 *     segments are checked relative to each collection's own root, so the `system`
 *     walk still skips `_changelog` and the files exist in exactly one collection.
 */
export const CHANGELOG_COLLECTION_KEY = 'changelog';

const BUILTIN_COLLECTIONS: ReadonlyArray<{
  key: string;
  label: string;
  origin: string;
  rootPath: string | null;
  brainDepth: DocBrainDepth;
}> = [
  { key: 'system', label: 'System docs', origin: 'system', rootPath: null, brainDepth: 'retrieval' },
  { key: 'guide', label: 'User Guide', origin: 'user', rootPath: 'guide', brainDepth: 'retrieval' },
  {
    key: CHANGELOG_COLLECTION_KEY,
    label: 'Changelog',
    origin: 'system',
    rootPath: '_changelog',
    brainDepth: 'retrieval',
  },
];

/** Ensure the built-in collections exist (disabled by default). Idempotent —
 *  called by the worker boot and the docs page so the rows are always there to
 *  toggle. `onConflictDoNothing` never flips `enabled` (preserves the operator's
 *  choice — e.g. a collection already enabled stays enabled). */
export async function ensureDefaultCollections(ownerId: string): Promise<void> {
  for (const c of BUILTIN_COLLECTIONS) {
    await db
      .insert(docCollections)
      .values({
        ownerId,
        key: c.key,
        label: c.label,
        origin: c.origin,
        rootPath: c.rootPath,
        brainDepth: c.brainDepth,
        enabled: false,
      })
      .onConflictDoNothing({ target: [docCollections.ownerId, docCollections.key] });
  }
}

/** List all collections for the owner (ensuring defaults exist first). */
export async function listDocCollections(ownerId: string): Promise<DocCollection[]> {
  await ensureDefaultCollections(ownerId);
  return db
    .select()
    .from(docCollections)
    .where(eq(docCollections.ownerId, ownerId))
    .orderBy(docCollections.label);
}

/**
 * Flip a collection on/off. Enabling runs the first reconcile immediately;
 * disabling purges the collection's indexed nodes. Returns the new row.
 */
export async function setCollectionEnabled(
  ownerId: string,
  collectionId: string,
  enabled: boolean,
): Promise<{ collection: DocCollection; reconciled?: ReconcileResult; purged?: number } | null> {
  const [updated] = await db
    .update(docCollections)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(docCollections.id, collectionId), eq(docCollections.ownerId, ownerId)))
    .returning();
  if (!updated) return null;
  if (enabled) {
    const reconciled = await reconcileCollection(ownerId, updated);
    return { collection: updated, reconciled };
  }
  const purged = await purgeCollection(ownerId, updated.key);
  return { collection: updated, purged };
}

/**
 * Create a new collection and (when enabled) run its first reconcile — the
 * write half of the /settings/documentation "New collection" form. Mirrors the
 * enable branch of `setCollectionEnabled`. Uniqueness on (owner,key) is enforced
 * by the DB index; the caller (server action) catches the violation and maps it
 * to a friendly message. Validation + the nested-root overlap guard also live in
 * the caller, so the engine stays dumb.
 */
export async function createDocCollection(
  ownerId: string,
  input: {
    key: string;
    label: string;
    rootPath: string | null;
    brainDepth: DocBrainDepth;
    origin: string;
    enabled?: boolean;
  },
): Promise<{ collection: DocCollection; reconciled?: ReconcileResult }> {
  const [row] = await db
    .insert(docCollections)
    .values({
      ownerId,
      key: input.key,
      label: input.label,
      origin: input.origin,
      rootPath: input.rootPath,
      brainDepth: input.brainDepth,
      enabled: input.enabled ?? true,
    })
    .returning();
  if (!row) throw new Error('createDocCollection: insert returned no row');
  if (row.enabled) {
    const reconciled = await reconcileCollection(ownerId, row);
    return { collection: row, reconciled };
  }
  return { collection: row };
}
