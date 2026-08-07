// Syncs @excalidraw/excalidraw's font assets into public/ so self-hosted
// instances never fetch fonts from the package CDN (esm.run). Runs from
// `generate` — same generated-into-public pattern as app-runtime.
//
// Deliberately a COPY of client/web's identical script, because each app
// serves its own public/ (the same rule the display fonts follow). This tier
// needs them because exportToSvg INLINES the fonts it uses, so the render
// island in the browser sidecar must fetch the very same woff2 files the
// editor did — otherwise a re-rendered snapshot silently comes back in
// fallback fonts and no longer matches the one the author committed.
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
