/**
 * Builds the CANVAS runtime: the vendored, pinned, offline library set a
 * Present canvas imports (docs/proposals/canvas-files.md section 6.1). Served
 * by the brain from `/canvas-runtime/`, never from a CDN: some boxes block
 * egress, a CDN would widen the frame CSP to third-party script hosts, and
 * versions would drift.
 *
 * Each library becomes ONE content-hashed ESM file (`<entry>-<hash>.js`), so a
 * canvas frame's import map is an address book only: the browser fetches a
 * library when the canvas imports it, then caches it for good. Three.js addons
 * import `three` through the same map, so a scene and its controls share one
 * Three. Plotly ships only a classic browser build: it is copied as is, and a
 * canvas loads it with a `<script src>`. reveal.js brings its stylesheet and
 * themes. KaTeX's stylesheet and fonts already ride `/share-runtime/katex/`.
 *
 * Output: the files plus `manifest.json` ({ imports, libs, assets }). The
 * canvas frame route reads `imports` for its import map; `libs` names each
 * library's pinned version (release notes, the save check of a later phase).
 * Built for canvases first and shaped so mini apps can read the same set
 * later; the mini-app bundler's allowlist (index.ts) is not touched here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const REAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_NS = 'canvas-entry';
const require = createRequire(import.meta.url);

/** One importable library: the bare specifier a canvas writes, the entry
 *  source that re-exports it, the npm package whose version it pins, and the
 *  specifiers left to the import map (a Three addon imports `three`). */
type CanvasModule = {
  specifier: string;
  entry: string;
  source: string;
  pkg: string;
  external?: string[];
};

/** The import map's modules, by bare specifier. A canvas writes exactly
 *  these names; anything else is not in the set. */
export const CANVAS_MODULES: readonly CanvasModule[] = [
  { specifier: 'echarts', entry: 'echarts', pkg: 'echarts', source: "export * from 'echarts';" },
  { specifier: 'd3', entry: 'd3', pkg: 'd3', source: "export * from 'd3';" },
  {
    specifier: 'konva',
    entry: 'konva',
    pkg: 'konva',
    source: "import Konva from 'konva';\nexport default Konva;",
  },
  { specifier: 'three', entry: 'three', pkg: 'three', source: "export * from 'three';" },
  {
    specifier: 'three/addons/controls/OrbitControls.js',
    entry: 'three-orbit-controls',
    pkg: 'three',
    source: "export * from 'three/addons/controls/OrbitControls.js';",
    external: ['three'],
  },
  { specifier: 'motion', entry: 'motion', pkg: 'motion', source: "export * from 'motion';" },
  {
    specifier: 'reveal.js',
    entry: 'reveal',
    pkg: 'reveal.js',
    source: "import Reveal from 'reveal.js';\nexport default Reveal;",
  },
  {
    specifier: 'katex',
    entry: 'katex',
    pkg: 'katex',
    source: "import katex from 'katex';\nexport default katex;",
  },
  {
    specifier: 'alpinejs',
    entry: 'alpine',
    pkg: 'alpinejs',
    source: "import Alpine from 'alpinejs';\nexport default Alpine;",
  },
];

/** Libraries with a classic browser build only, loaded with `<script src>`
 *  (the path is stable, so the authoring skill can name it). */
const CLASSIC_SCRIPTS: readonly { pkg: string; from: string; to: string }[] = [
  { pkg: 'plotly.js-dist-min', from: 'plotly.min.js', to: 'plotly/plotly.min.js' },
];

/** Stylesheets copied beside the modules, at stable paths. */
const STYLE_ASSETS: readonly { pkg: string; from: string; to: string }[] = [
  { pkg: 'reveal.js', from: 'dist/reveal.css', to: 'reveal/reveal.css' },
  { pkg: 'reveal.js', from: 'dist/theme', to: 'reveal/theme' },
];

export type CanvasRuntimeManifest = {
  /** Bare specifier → hashed URL under the prefix (the import map). */
  imports: Record<string, string>;
  /** npm package → the version this runtime pins. */
  libs: Record<string, string>;
  /** The stable non-module paths (classic scripts, stylesheets). */
  assets: string[];
  builtAt: string;
};

/** A package's install directory. Not `require.resolve('<pkg>/package.json')`:
 *  a package whose `exports` omits it (reveal.js) refuses that. */
function packageDir(pkg: string): string {
  for (const base of require.resolve.paths(pkg) ?? []) {
    const dir = path.join(base, pkg);
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  throw new Error(`canvas runtime: package '${pkg}' is not installed`);
}

function packageVersion(pkg: string): string {
  const json = JSON.parse(fs.readFileSync(path.join(packageDir(pkg), 'package.json'), 'utf8')) as {
    version: string;
  };
  return json.version;
}

function entryPlugin(): esbuild.Plugin {
  const byEntry = new Map(CANVAS_MODULES.map((m) => [m.entry, m.source]));
  return {
    name: 'canvas-runtime',
    setup(build) {
      build.onResolve({ filter: /^entry:/ }, (args) => ({
        path: args.path.slice('entry:'.length),
        namespace: ENTRY_NS,
      }));
      build.onLoad({ filter: /.*/, namespace: ENTRY_NS }, (args) => ({
        contents: byEntry.get(args.path) ?? '',
        loader: 'js',
        resolveDir: REAL_DIR,
      }));
    },
  };
}

/** Leave exactly these specifiers to the import map. Not esbuild's
 *  `external`, which also takes every subpath (`three` would take the addon
 *  being built, `three/addons/...`, and bundle nothing). */
function exactExternals(names: readonly string[]): esbuild.Plugin {
  return {
    name: 'canvas-exact-externals',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) =>
        names.includes(args.path) ? { path: args.path, external: true } : undefined,
      );
    },
  };
}

/** The canvas runtime's import map JSON for a manifest (imports only). */
export function canvasImportMapJson(manifest: Pick<CanvasRuntimeManifest, 'imports'>): string {
  return JSON.stringify({ imports: manifest.imports });
}

/**
 * Build the canvas runtime into `outDir` (server/web/public/canvas-runtime)
 * and return its manifest. `urlPrefix` is the public path it is served at.
 */
export async function buildCanvasRuntime(
  outDir: string,
  urlPrefix = '/canvas-runtime/',
): Promise<CanvasRuntimeManifest> {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const imports: Record<string, string> = {};
  // One build per module: each is self-contained, except the externals it
  // names, which the import map resolves at run time.
  for (const m of CANVAS_MODULES) {
    const result = await esbuild.build({
      entryPoints: [{ in: `entry:${m.entry}`, out: m.entry }],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      minify: true,
      legalComments: 'none',
      define: { 'process.env.NODE_ENV': '"production"' },
      outdir: outDir,
      entryNames: '[name]-[hash]',
      write: true,
      metafile: true,
      logLevel: 'silent',
      plugins: [entryPlugin(), exactExternals(m.external ?? [])],
    });
    const out = Object.keys(result.metafile.outputs).find((p) => p.endsWith('.js'));
    if (!out) throw new Error(`canvas runtime: no output for '${m.specifier}'`);
    imports[m.specifier] = urlPrefix + path.basename(out);
  }

  const assets: string[] = [];
  for (const a of [...CLASSIC_SCRIPTS, ...STYLE_ASSETS]) {
    const from = path.join(packageDir(a.pkg), a.from);
    const to = path.join(outDir, a.to);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    assets.push(urlPrefix + a.to);
  }

  const libs: Record<string, string> = {};
  for (const pkg of new Set([
    ...CANVAS_MODULES.map((m) => m.pkg),
    ...CLASSIC_SCRIPTS.map((s) => s.pkg),
  ])) {
    libs[pkg] = packageVersion(pkg);
  }

  const manifest: CanvasRuntimeManifest = {
    imports,
    libs,
    assets,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
