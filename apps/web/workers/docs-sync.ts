/**
 * Docs watcher. Syncs markdown under each ENABLED documentation collection's
 * root into the brain as `type='documentation'` nodes.
 *
 * Two responsibilities, cleanly split:
 *   - reconcile (boot + on-enable): the source of truth. Walks each enabled
 *     collection, sha-diffs against the DB, indexes only what changed, deletes
 *     docs whose file is gone. In prod (immutable baked-in docs) this is the
 *     ONLY indexing path — the files-watcher's `ignoreInitial` would miss them.
 *   - watcher (live dev edits): chokidar over enabled roots, funnelling through
 *     the same sha-gated `upsertDocFromDisk` so it can't conflict with reconcile.
 *
 * Opt-in: DISABLED collections are never walked or watched. The worker refreshes
 * the enabled set every 60s, so toggling a collection at /docs
 * starts/stops sync without a restart.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import type { DocCollection } from '@mantle/db';
import {
  collectionRoot,
  deleteDocByRelPath,
  ensureDefaultCollections,
  listDocCollections,
  ltreeForDocPath,
  reconcileCollection,
  upsertDocFromDisk,
} from '@mantle/files';

const USER_ID = process.env.ALLOWED_USER_ID;
if (!USER_ID) {
  console.error('[docs-sync] ALLOWED_USER_ID must be set');
  process.exit(1);
}

const REFRESH_MS = 60_000;

/** Currently-enabled collections, by id. */
let enabled = new Map<string, DocCollection>();
let watcher: FSWatcher | null = null;

function isMarkdown(base: string): boolean {
  if (base.startsWith('.')) return false;
  if (base.endsWith('~') || base.endsWith('.swp') || base.endsWith('.tmp')) return false;
  return /\.(md|markdown)$/i.test(base);
}

/** Which enabled collection owns this absolute path (longest matching root). */
function collectionForAbsPath(abs: string): { collection: DocCollection; relPath: string } | null {
  let best: { collection: DocCollection; relPath: string } | null = null;
  let bestLen = -1;
  for (const col of enabled.values()) {
    const root = collectionRoot(col);
    const loc = ltreeForDocPath(abs, root);
    if (loc && root.length > bestLen) {
      best = { collection: col, relPath: loc.relPath };
      bestLen = root.length;
    }
  }
  return best;
}

async function handleUpsert(abs: string): Promise<void> {
  try {
    if (!isMarkdown(path.basename(abs))) return;
    const match = collectionForAbsPath(abs);
    if (!match) return;
    const bytes = await fs.readFile(abs);
    const res = await upsertDocFromDisk({
      ownerId: USER_ID!,
      collection: match.collection,
      relPath: match.relPath,
      bytes,
    });
    if (res.status !== 'noop') {
      console.log(`[docs-sync] ${res.status} ${match.collection.key}/${match.relPath}`);
    }
  } catch (err) {
    console.error('[docs-sync] upsert failed', abs, err);
  }
}

async function handleUnlink(abs: string): Promise<void> {
  try {
    if (!isMarkdown(path.basename(abs))) return;
    const match = collectionForAbsPath(abs);
    if (!match) return;
    const res = await deleteDocByRelPath({
      ownerId: USER_ID!,
      collection: match.collection.key,
      relPath: match.relPath,
    });
    if (res.ok) console.log(`[docs-sync] deleted ${match.collection.key}/${match.relPath}`);
  } catch (err) {
    console.error('[docs-sync] unlink failed', abs, err);
  }
}

/** Rebuild the chokidar watcher to cover exactly the enabled roots. */
async function rebuildWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
  const roots = [...new Set([...enabled.values()].map(collectionRoot))];
  if (roots.length === 0) {
    console.log('[docs-sync] no enabled collections — watcher idle');
    return;
  }
  watcher = chokidar.watch(roots, {
    ignoreInitial: true, // boot indexing is reconcile's job, not the watcher's
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    ignored: (p) => {
      const base = path.basename(p);
      return base.startsWith('.') || base.endsWith('~') || base.endsWith('.swp') || base.endsWith('.tmp');
    },
  });
  watcher.on('add', handleUpsert);
  watcher.on('change', handleUpsert);
  watcher.on('unlink', handleUnlink);
  watcher.on('error', (err) => console.error('[docs-sync] chokidar error', err));
  console.log(`[docs-sync] watching ${roots.length} root(s): ${roots.join(', ')}`);
}

/** Refresh the enabled set; reconcile newly-enabled collections; rebuild the
 *  watcher if the root set changed. */
async function refresh(): Promise<void> {
  const cols = await listDocCollections(USER_ID!);
  const next = new Map(cols.filter((c) => c.enabled).map((c) => [c.id, c] as const));

  // Reconcile collections that just became enabled (boot: all enabled count).
  for (const [id, col] of next) {
    if (!enabled.has(id)) {
      const res = await reconcileCollection(USER_ID!, col);
      console.log(`[docs-sync] reconcile '${col.key}'`, res);
    }
  }

  const rootsChanged =
    [...next.values()].map(collectionRoot).sort().join('|') !==
    [...enabled.values()].map(collectionRoot).sort().join('|');
  enabled = next;
  if (rootsChanged) await rebuildWatcher();
}

async function main() {
  await ensureDefaultCollections(USER_ID!);
  await refresh(); // boot reconcile + initial watcher
  const timer = setInterval(() => {
    refresh().catch((err) => console.error('[docs-sync] refresh failed', err));
  }, REFRESH_MS);
  console.log('[docs-sync] ready');

  const shutdown = async () => {
    console.log('[docs-sync] shutting down…');
    clearInterval(timer);
    if (watcher) await watcher.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

process.on('unhandledRejection', (reason) => {
  console.error('[docs-sync] unhandledRejection (kept alive):', reason);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
