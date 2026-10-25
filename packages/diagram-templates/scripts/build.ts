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
 * The templates are committed; src/canvas-fresh.test.ts fails when they
 * are older than the source. Run: pnpm -C packages/diagram-templates build
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { bundleRuntime, ROOT, TEMPLATE_SAMPLES, templateCanvas } from './bundle.ts';

const DIST = path.join(ROOT, 'dist');
mkdirSync(DIST, { recursive: true });
const { iife, esm } = await bundleRuntime();
writeFileSync(path.join(DIST, 'diagram-runtime.js'), iife);
writeFileSync(path.join(DIST, 'diagram-runtime.mjs'), esm);

const kb = (f: string) => `${(statSync(f).size / 1024).toFixed(1)} KB`;
console.log(
  `runtime: ${kb(path.join(DIST, 'diagram-runtime.js'))} (iife), ${kb(path.join(DIST, 'diagram-runtime.mjs'))} (esm)`,
);

mkdirSync(path.join(ROOT, 'templates'), { recursive: true });
for (const name of Object.keys(TEMPLATE_SAMPLES) as ('flow' | 'pid')[]) {
  const out = path.join(ROOT, 'templates', `${name}.canvas.html`);
  writeFileSync(out, templateCanvas(name, iife));
  console.log(`template: ${path.relative(ROOT, out)} ${kb(out)}`);
}
