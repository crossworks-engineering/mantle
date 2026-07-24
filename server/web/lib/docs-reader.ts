
import path from 'node:path';
import {
  CHANGELOG_COLLECTION_KEY,
  builtinDocCollections,
  collectionRoot,
  isHiddenDocRelPath,
  listDocCollections,
  listMarkdownRelPaths,
  readMarkdownFile,
} from '@mantle/files';
import type { DocCollection } from '@mantle/db';
import { docLabelFromRelPath } from '@mantle/web-ui/docs-labels';
import { isDetachedDev } from '@/lib/auth-constants';

/** Collections for the disk reader. Detached dev (`pnpm dev:fe`) has no local
 *  Postgres, so it reads the built-ins straight off disk (the User Guide +
 *  system docs live in the repo) instead of the DB — a direct DB read here 500s
 *  the whole `/docs` route in detached mode (docs/db-less-dev.md). */
async function readerCollections(ownerId: string): Promise<DocCollection[]> {
  if (isDetachedDev()) return builtinDocCollections(ownerId);
  return listDocCollections(ownerId);
}

/**
 * Disk-backed read layer for the `/docs` reader. Reads markdown straight from each
 * collection's disk root (via the pure `@mantle/files` helpers), so docs are
 * browsable whether or not a collection is indexed into the brain. Indexing
 * (`enabled`) is surfaced only as a badge, never required for reading.
 */

export type ReaderCollection = {
  key: string;
  label: string;
  origin: string;
  enabled: boolean; // = "indexed" (drives the badge); reading works regardless
  files: string[]; // collection-relative .md paths, nested-root-subtracted, sorted
};

export type ReaderNav = ReaderCollection[];

export type ReaderDocLink = { collectionKey: string; relPath: string; label: string };

export type ReaderDoc = {
  collectionKey: string;
  collectionLabel: string;
  enabled: boolean;
  relPath: string;
  content: string;
  prev: ReaderDocLink | null;
  next: ReaderDocLink | null;
};

/** True when `inner` is strictly nested under `outer` (path.sep-aware prefix). */
function isStrictlyNested(inner: string, outer: string): boolean {
  return inner !== outer && inner.startsWith(outer + path.sep);
}

/**
 * Files for one collection, with **nested-root subtraction**: drop any file that
 * lives under another collection whose resolved root is strictly nested under this
 * one. Keeps `system` (root = docs/) from duplicating the User Guide (docs/guide).
 *
 * Sort is numeric-aware (so `0.20.68` orders before `0.100.0`), and the changelog
 * collection is reversed — release notes read newest-first, and prev/next follow.
 */
async function filesForCollection(
  col: DocCollection,
  roots: Map<string, string>,
): Promise<string[]> {
  const root = roots.get(col.key)!;
  const files = await listMarkdownRelPaths(root);
  const nestedPrefixes: string[] = [];
  for (const [otherKey, otherRoot] of roots) {
    if (otherKey === col.key) continue;
    if (isStrictlyNested(otherRoot, root)) {
      nestedPrefixes.push(path.relative(root, otherRoot).split(path.sep).join('/') + '/');
    }
  }
  const filtered = nestedPrefixes.length
    ? files.filter((rel) => !nestedPrefixes.some((p) => rel.startsWith(p)))
    : files;
  filtered.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (col.key === CHANGELOG_COLLECTION_KEY) filtered.reverse();
  return filtered;
}

/** All collections (incl. system + disabled), each with its disk files. */
export async function getReaderNav(ownerId: string): Promise<ReaderNav> {
  const cols = await readerCollections(ownerId);
  const roots = new Map<string, string>();
  for (const c of cols) roots.set(c.key, collectionRoot(c));

  const out: ReaderCollection[] = [];
  for (const c of cols) {
    out.push({
      key: c.key,
      label: c.label,
      origin: c.origin,
      enabled: c.enabled,
      files: await filesForCollection(c, roots),
    });
  }
  // User-authored collections (the User Guide) first; the built-in `system`
  // dev docs last. Alphabetical within each group.
  const rank = (origin: string) => (origin === 'system' ? 1 : 0);
  out.sort((a, b) => rank(a.origin) - rank(b.origin) || a.label.localeCompare(b.label));
  return out;
}

/** One doc read from disk, with prev/next within its collection. Null when the
 *  collection is unknown or the file is missing/invalid (the route 404s on null —
 *  this is the authoritative path-traversal guard, via readMarkdownFile). */
export async function getReaderDoc(
  ownerId: string,
  collectionKey: string,
  relPath: string,
): Promise<ReaderDoc | null> {
  if (isHiddenDocRelPath(relPath)) return null; // hidden (_archive/…) — not browsable

  const cols = await readerCollections(ownerId);
  const col = cols.find((c) => c.key === collectionKey);
  if (!col) return null;

  const root = collectionRoot(col);
  const content = await readMarkdownFile(root, relPath);
  if (content === null) return null;

  const roots = new Map<string, string>();
  for (const c of cols) roots.set(c.key, collectionRoot(c));
  const files = await filesForCollection(col, roots);
  const idx = files.indexOf(relPath);
  const toLink = (rel: string | undefined): ReaderDocLink | null =>
    rel ? { collectionKey, relPath: rel, label: docLabelFromRelPath(rel) } : null;

  return {
    collectionKey,
    collectionLabel: col.label,
    enabled: col.enabled,
    relPath,
    content,
    prev: idx > 0 ? toLink(files[idx - 1]) : null,
    next: idx >= 0 && idx < files.length - 1 ? toLink(files[idx + 1]) : null,
  };
}
