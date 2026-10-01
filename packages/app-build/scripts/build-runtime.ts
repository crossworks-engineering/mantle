/**
 * Emits the shared mini-app runtime into an app's `public/app-runtime/`.
 * Run with: `node packages/app-build/scripts/build-runtime.ts` from the app
 * directory (Node strips the TS types). Invoked from `predev`/`prebuild` in
 * server/web, so the runtime always exists before apps render.
 *
 * Repo-only: the published package ships `src/` alone (`files`), so this
 * script is not on npm. Nothing outside the repo needs it — jackdaw's owner UI
 * used to build its own copy but never served it to anything, since every
 * sandbox frames a brain-rendered document whose import map and CSP point at
 * the brain's `/app-runtime/` (jackdaw dropped the step after v0.6.131).
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { buildRuntime } from '../src/build-runtime.ts';

/**
 * Where to write: the app that renders the frame documents (server/web).
 *
 * Paths resolve from the CALLER'S CWD, never from this script's own location.
 * They used to resolve against `../../..` from here, which is the repo root
 * only while this package sits in the repo being built. When the script was
 * still published and run from jackdaw, that expression pointed at the
 * consumer's `node_modules/` and wrote the runtime into a directory nothing
 * served, while the build printed a success line naming the wrong path.
 *
 * An ARGUMENT rather than an environment variable, deliberately. The callers
 * used to set `APP_RUNTIME_OUT="$PWD/…"` inline, which is POSIX shell syntax;
 * pnpm runs package scripts through cmd.exe on Windows, where that is not a
 * variable assignment but an unknown command. The desktop build failed on
 * windows-latest for four consecutive releases with
 * `'APP_RUNTIME_OUT' is not recognized`. An argv entry has no shell semantics
 * to get wrong.
 *
 * `APP_RUNTIME_OUT` still works for a direct absolute-path invocation.
 */
const appArg = process.argv[2]?.trim();
const appDir = path.resolve(process.cwd(), appArg ?? '.');
const outDir = process.env.APP_RUNTIME_OUT
  ? path.resolve(process.env.APP_RUNTIME_OUT)
  : path.join(appDir, 'public/app-runtime');

// Tripwire for the failure above: a Next app always has a `public/`, so its
// absence means the resolved app directory is not an app and the runtime is
// about to be written somewhere nothing serves. Fail loudly here rather than
// print a cheerful success line pointing into node_modules. Skipped when
// APP_RUNTIME_OUT names the destination outright.
if (!process.env.APP_RUNTIME_OUT && !existsSync(path.join(appDir, 'public'))) {
  console.error(
    `app-runtime: ${appDir} has no public/ directory, so it is not an app.\n` +
      `Run this from the app directory (paths resolve from the cwd), or pass an ` +
      `absolute destination as APP_RUNTIME_OUT.`,
  );
  process.exit(1);
}

const manifest = await buildRuntime(outDir);
const n = Object.keys(manifest.imports).length;
console.log(`app-runtime: ${n} modules → ${outDir}`);
for (const [spec, url] of Object.entries(manifest.imports)) console.log(`  ${spec}  →  ${url}`);
