/**
 * Builds public/share-runtime/ — everything the server-rendered surfaces
 * (/s share pages, /print) need at the browser end, replacing what Next's
 * build used to produce:
 *
 *   styles.css        Tailwind v4 compile of app/globals.css (theme tokens,
 *                     ~40 palettes, editor/prose CSS, utilities used by the
 *                     presenters + web-ui components).
 *   islands.js        esbuild bundle of server/islands/entry.tsx (the three
 *                     interactive share presenters, React included).
 *   katex/            katex.min.css + its font files (math nodes).
 *
 * Wired into predev/prebuild alongside app-runtime generation. Output is
 * gitignored; served by server/static.ts with no-cache semantics implicit in
 * dev (files are small and share traffic is light — content-hashing can come
 * later if it ever matters).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(webRoot, 'public/share-runtime');
const require = createRequire(import.meta.url);

mkdirSync(outDir, { recursive: true });

// ── 1. Tailwind: globals.css → styles.css ────────────────────────────────────
// The CLI auto-detects sources from cwd (server/web); web-ui lives outside it,
// so app/globals.css carries an explicit @source for it. Resolved via the bin
// shim (the package exports no JS entry point).
const tailwind = join(webRoot, 'node_modules/.bin/tailwindcss');
execFileSync(
  tailwind,
  ['-i', join(webRoot, 'app/globals.css'), '-o', join(outDir, 'styles.css'), '--minify'],
  { cwd: webRoot, stdio: ['ignore', 'ignore', 'inherit'] },
);

// ── 2. Islands bundle ────────────────────────────────────────────────────────
await esbuild.build({
  entryPoints: [join(webRoot, 'server/islands/entry.tsx')],
  outfile: join(outDir, 'islands.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

// ── 3. KaTeX css + fonts ─────────────────────────────────────────────────────
const katexCss = require.resolve('katex/dist/katex.min.css');
const katexDist = dirname(katexCss);
rmSync(join(outDir, 'katex'), { recursive: true, force: true });
mkdirSync(join(outDir, 'katex'), { recursive: true });
cpSync(katexCss, join(outDir, 'katex/katex.min.css'));
cpSync(join(katexDist, 'fonts'), join(outDir, 'katex/fonts'), { recursive: true });

console.log(`share-runtime: styles.css + islands.js + katex → ${outDir}`);
