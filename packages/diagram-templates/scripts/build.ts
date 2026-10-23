/**
 * Builds the browser runtime into dist/ and writes the blank templates.
 *
 *   dist/diagram-runtime.js   one classic script (IIFE): every template, the
 *                             layout library (dagre) and the house style;
 *                             it mounts the canvas it sits in
 *   dist/diagram-runtime.mjs  the same as an ES module exporting `mount`,
 *                             for a host import map (canvas mode 'import')
 *   templates/<name>.canvas.html   each template as a ready canvas holding
 *                             its first sample's data
 *
 * Run: pnpm -C packages/diagram-templates build
 */
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { buildCanvas } from '../src/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
mkdirSync(DIST, { recursive: true });

const common = {
  bundle: true,
  minify: true,
  platform: 'browser',
  target: 'es2020',
  legalComments: 'none',
  logLevel: 'silent',
} as const;

await esbuild.build({
  ...common,
  stdin: {
    contents: "import { mount } from './src/browser.ts';\nmount();\n",
    resolveDir: ROOT,
    sourcefile: 'inline-entry.ts',
    loader: 'ts',
  },
  format: 'iife',
  outfile: path.join(DIST, 'diagram-runtime.js'),
  // The dagre licence travels with the bundle (MIT asks for the notice).
  banner: {
    js: '/* @mantle/diagram-templates runtime. Bundles @dagrejs/dagre and @dagrejs/graphlib (MIT, see THIRD-PARTY-NOTICES.md). */',
  },
});
await esbuild.build({
  ...common,
  entryPoints: [path.join(ROOT, 'src/browser.ts')],
  format: 'esm',
  outfile: path.join(DIST, 'diagram-runtime.mjs'),
  banner: {
    js: '/* @mantle/diagram-templates runtime. Bundles @dagrejs/dagre and @dagrejs/graphlib (MIT, see THIRD-PARTY-NOTICES.md). */',
  },
});

const runtime = readFileSync(path.join(DIST, 'diagram-runtime.js'), 'utf8');
const kb = (f: string) => `${(statSync(f).size / 1024).toFixed(1)} KB`;
console.log(
  `runtime: ${kb(path.join(DIST, 'diagram-runtime.js'))} (iife), ${kb(path.join(DIST, 'diagram-runtime.mjs'))} (esm)`,
);

const TEMPLATE_SAMPLES: Record<'flow' | 'pid', string> = {
  flow: 'samples/flow-ingest.json',
  pid: 'samples/pid-feed-drum.json',
};
mkdirSync(path.join(ROOT, 'templates'), { recursive: true });
for (const [name, sample] of Object.entries(TEMPLATE_SAMPLES) as ['flow' | 'pid', string][]) {
  const data = JSON.parse(readFileSync(path.join(ROOT, sample), 'utf8'));
  const html = buildCanvas({ template: name, data, runtime });
  const out = path.join(ROOT, 'templates', `${name}.canvas.html`);
  writeFileSync(out, html);
  console.log(`template: ${path.relative(ROOT, out)} ${kb(out)}`);
}
