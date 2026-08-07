// Syncs @excalidraw/excalidraw's font assets into public/ so self-hosted
// instances never fetch fonts from the package CDN (esm.run). Runs from
// pre(dev|build) — same generated-into-public pattern as app-runtime.
// The destination is gitignored; ~13 MB of content-hashed woff2 files do
// not belong in the repo. Delete-then-copy so hashes from a previous
// package version never accumulate.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(appRoot, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
const dest = join(appRoot, 'public/excalidraw-assets/fonts');

if (!existsSync(src)) {
  console.error(`[excalidraw-assets] source missing: ${src} — run pnpm install`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true, dereference: true });
console.log('[excalidraw-assets] fonts synced to public/excalidraw-assets/fonts');
