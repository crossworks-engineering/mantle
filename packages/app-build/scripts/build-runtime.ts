/**
 * Emits the shared mini-app runtime into server/web/public/app-runtime/.
 * Run with: `node packages/app-build/scripts/build-runtime.ts` (Node strips the
 * TS types). Wired as `pnpm -C packages/app-build build:runtime` and invoked
 * from server/web's prebuild so the runtime always exists before apps render.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntime } from '../src/build-runtime.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// Out dir comes from the invoking app (each Next app serves its own copy —
// the ACAO:* runtime must exist on every origin that renders sandboxes).
// Fallback: the server app, for bare invocations.
const outDir = process.env.APP_RUNTIME_OUT
  ? path.resolve(process.env.APP_RUNTIME_OUT)
  : path.resolve(here, '../../../server/web/public/app-runtime');

const manifest = await buildRuntime(outDir);
const n = Object.keys(manifest.imports).length;
console.log(`app-runtime: ${n} modules → ${outDir}`);
for (const [spec, url] of Object.entries(manifest.imports)) console.log(`  ${spec}  →  ${url}`);
