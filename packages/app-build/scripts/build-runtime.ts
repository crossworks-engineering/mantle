/**
 * Emits the shared mini-app runtime into apps/web/public/app-runtime/.
 * Run with: `node packages/app-build/scripts/build-runtime.ts` (Node strips the
 * TS types). Wired as `pnpm -C packages/app-build build:runtime` and invoked
 * from apps/web's prebuild so the runtime always exists before apps render.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntime } from '../src/build-runtime.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../../apps/web/public/app-runtime');

const manifest = await buildRuntime(outDir);
const n = Object.keys(manifest.imports).length;
console.log(`app-runtime: ${n} modules → ${outDir}`);
for (const [spec, url] of Object.entries(manifest.imports)) console.log(`  ${spec}  →  ${url}`);
