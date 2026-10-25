/**
 * The browser runtime and the blank template canvases, built in memory.
 * scripts/build.ts writes them to disk; the freshness test builds them the
 * same way and compares them with the committed templates/*.canvas.html.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { buildCanvas } from '../src/index.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const common = {
  bundle: true,
  minify: true,
  platform: 'browser',
  target: 'es2020',
  legalComments: 'none',
  logLevel: 'silent',
  write: false,
} as const;

/** The dagre licence travels with the bundle (MIT asks for the notice). */
const BANNER =
  '/* @mantle/diagram-templates runtime. Bundles @dagrejs/dagre and @dagrejs/graphlib (MIT, see THIRD-PARTY-NOTICES.md). */';

/** The runtime as one classic script (IIFE) that mounts the canvas it sits
 *  in, and as an ES module exporting `mount`. */
export async function bundleRuntime(): Promise<{ iife: string; esm: string }> {
  const iife = await esbuild.build({
    ...common,
    stdin: {
      contents: "import { mount } from './src/browser.ts';\nmount();\n",
      resolveDir: ROOT,
      sourcefile: 'inline-entry.ts',
      loader: 'ts',
    },
    format: 'iife',
    outfile: path.join(ROOT, 'dist', 'diagram-runtime.js'),
    banner: { js: BANNER },
  });
  const esm = await esbuild.build({
    ...common,
    entryPoints: [path.join(ROOT, 'src/browser.ts')],
    format: 'esm',
    outfile: path.join(ROOT, 'dist', 'diagram-runtime.mjs'),
    banner: { js: BANNER },
  });
  return { iife: iife.outputFiles[0]!.text, esm: esm.outputFiles[0]!.text };
}

/** Each template's blank canvas holds its first sample's data. */
export const TEMPLATE_SAMPLES: Record<'flow' | 'pid', string> = {
  flow: 'samples/flow-ingest.json',
  pid: 'samples/pid-feed-drum.json',
};

/** A template's ready canvas around `runtime` (the IIFE). */
export function templateCanvas(name: 'flow' | 'pid', runtime: string): string {
  const data = JSON.parse(readFileSync(path.join(ROOT, TEMPLATE_SAMPLES[name]), 'utf8'));
  return buildCanvas({ template: name, data, runtime });
}
