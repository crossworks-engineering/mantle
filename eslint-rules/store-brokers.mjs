/**
 * store-brokers (workspaces arch plan v2, sections 6 and 11; A3b;
 * docs/store-brokers.md): only a store's broker writes its disk. Each store
 * splits its API: readers keep the read entry, and the WRITE API
 * (arch-counts.mjs STORES: @mantle/tabledb/write, @mantle/storage/write,
 * the app SQL runner's writing functions and APP_DB_DIR) is reached only by
 * the files pinned here, store by store.
 *
 * The rule flags a file that reaches a store's write API without a pin for
 * that store; eslint-rules/arch-lints.test.ts holds the pins exactly, so a
 * file may only leave a list (a new writer is a review decision: it goes
 * through the store's broker instead).
 *
 * The docs store has no write API at all: the docs feature reads markdown
 * from disk and writes only Postgres rows (system(worker:docs-sync)).
 * DOCS_STORE_FILES may import no file-writing function (arch-lints.test.ts).
 */
import { isCounted, repoPathOf, storesReached } from './arch-counts.mjs';

/** @type {Record<string, string[]>} files per store that reach its write API */
export const STORE_PINS = {
  appdb: [
    // The settings schema names the directory; nothing is written there.
    'packages/config/src/index.ts',
    // THE app database broker: the only writer of an app's SQLite file.
    'packages/content/src/app-broker.ts',
    // An imported package's data, checked into a TEMP file
    // (adoptAppDbFile); the store write is the broker's restore.
    'packages/content/src/app-package.ts',
    // Snapshot copies of app databases (copyAppDbFile): the snapshot
    // store, A3b part 2.
    'packages/content/src/history-files.ts',
    // The trash sweep's description names the directory.
    'server/web/lib/maintenance/registry.ts',
  ],
  objectstore: [
    // Email attachments' bytes: the files store, A3b part 2.
    'packages/email/src/sync.ts',
    // OneDrive / SharePoint files' bytes: the files store, A3b part 2.
    'packages/microsoft/src/drives/store.ts',
    // THE app build broker: bundles, after the app row's checked write.
    'packages/tools/src/app-build-stage.ts',
    // A login's logo and photo (not one of the six item stores).
    'server/web/app/api/profile/logo/route.ts',
    'server/web/app/api/profile/photo/route.ts',
  ],
  tabledb: [
    // THE tables broker: the only writer of a table's workbook files.
    'packages/content/src/table-broker.ts',
  ],
};

/** The docs feature: it reads markdown and writes rows, never the disk. */
export const DOCS_STORE_FILES = [
  'packages/files/src/docs.ts',
  'server/web/lib/docs-reader.ts',
  'server/web/workers/docs-sync.ts',
];

/** The file-writing functions of node:fs and node:fs/promises. */
export const FS_WRITE_NAMES = [
  'appendFile',
  'appendFileSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'createWriteStream',
  'link',
  'linkSync',
  'mkdir',
  'mkdirSync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'symlink',
  'symlinkSync',
  'truncate',
  'truncateSync',
  'unlink',
  'unlinkSync',
  'writeFile',
  'writeFileSync',
];

/** The fs write functions `text` imports by name, or uses through a
 *  namespace import (`fs.writeFile`). */
export function fsWritesIn(text) {
  const out = new Set();
  const named = /import\s*\{([^}]*)\}\s*from\s*'node:fs(?:\/promises)?'/g;
  let m;
  while ((m = named.exec(text))) {
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (FS_WRITE_NAMES.includes(name)) out.add(name);
    }
  }
  const ns = /import\s+\*\s+as\s+(\w+)\s+from\s*'node:fs(?:\/promises)?'/g;
  while ((m = ns.exec(text))) {
    const re = new RegExp(`\\b${m[1]}\\.(\\w+)\\s*\\(`, 'g');
    let c;
    while ((c = re.exec(text))) if (FS_WRITE_NAMES.includes(c[1])) out.add(c[1]);
  }
  return [...out].sort();
}

export const rule = {
  meta: {
    type: 'problem',
    docs: { description: "Only a store's broker reaches its write API (plan v2, section 6; A3b)." },
    messages: {
      unpinned:
        "This file reaches the {{store}} store's write API. Only the store's broker writes its disk (docs/store-brokers.md): go through the broker, or pin the file in eslint-rules/store-brokers.mjs (review).",
    },
    schema: [],
  },
  create(context) {
    const path = repoPathOf(context.filename);
    if (!path || !isCounted(path)) return {};
    return {
      Program(node) {
        for (const store of storesReached(context.sourceCode.getText())) {
          if (!(STORE_PINS[store] ?? []).includes(path)) {
            context.report({ node, messageId: 'unpinned', data: { store } });
          }
        }
      },
    };
  },
};

export default { rules: { 'store-brokers': rule } };
