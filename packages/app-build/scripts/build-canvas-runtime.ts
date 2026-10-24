/**
 * Emits the canvas runtime (the vendored library set Present canvases import)
 * into an app's `public/canvas-runtime/`. Run from the app directory, as
 * build-runtime.ts is: `node packages/app-build/scripts/build-canvas-runtime.ts`
 * (Node strips the TS types). Invoked from server/web `generate`.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { buildCanvasRuntime } from '../src/canvas-runtime.ts';

const appDir = path.resolve(process.cwd(), process.argv[2]?.trim() || '.');
if (!existsSync(path.join(appDir, 'public'))) {
  console.error(`canvas-runtime: ${appDir} has no public/ directory, so it is not an app.`);
  process.exit(1);
}
const outDir = path.join(appDir, 'public/canvas-runtime');
const manifest = await buildCanvasRuntime(outDir, '/canvas-runtime/', appDir);
console.log(`canvas-runtime: ${Object.keys(manifest.imports).length} modules → ${outDir}`);
for (const [spec, url] of Object.entries(manifest.imports)) console.log(`  ${spec}  →  ${url}`);
// The app runtime's import map names some of these hashed files
// (app-libraries.ts): it is stale until the app runtime is built again,
// which server/web `generate` does next. Run on its own, say so.
console.log(
  'canvas-runtime: rebuild the app runtime next (server/web `app-runtime`), or mini apps keep the old library URLs.',
);
