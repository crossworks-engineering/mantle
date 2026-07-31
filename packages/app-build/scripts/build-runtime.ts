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
const repoRoot = path.resolve(here, '../../..');

/**
 * Which app is asking. Each Next app serves its own copy — the ACAO:* runtime
 * has to exist on every origin that renders sandboxes — so the caller names
 * itself and this resolves the path from the repo root.
 *
 * An ARGUMENT rather than an environment variable, deliberately. The callers
 * used to set `APP_RUNTIME_OUT="$PWD/…"` inline, which is POSIX shell syntax;
 * pnpm runs package scripts through cmd.exe on Windows, where that is not a
 * variable assignment but an unknown command. The desktop build failed on
 * windows-latest for four consecutive releases with
 * `'APP_RUNTIME_OUT' is not recognized`. An argv entry has no shell semantics
 * to get wrong.
 *
 * `APP_RUNTIME_OUT` still works for a direct absolute-path invocation; the bare
 * default remains the server app.
 */
const appArg = process.argv[2]?.trim();
const outDir = appArg
  ? path.resolve(repoRoot, appArg, 'public/app-runtime')
  : process.env.APP_RUNTIME_OUT
    ? path.resolve(process.env.APP_RUNTIME_OUT)
    : path.resolve(repoRoot, 'server/web/public/app-runtime');

const manifest = await buildRuntime(outDir);
const n = Object.keys(manifest.imports).length;
console.log(`app-runtime: ${n} modules → ${outDir}`);
for (const [spec, url] of Object.entries(manifest.imports)) console.log(`  ${spec}  →  ${url}`);
