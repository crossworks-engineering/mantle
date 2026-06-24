/**
 * Builds the SHARED app runtime — the React/UI-kit/host-bridge modules that
 * every mini app imports but that used to be re-bundled into each app's output.
 *
 * Instead of each app shipping its own ~40 KB React + kit, we build those once
 * into a small set of content-hashed ESM files served from a stable, cacheable,
 * CORS-enabled URL (`/app-runtime/*`). Apps then mark these specifiers external
 * (see index.ts) and the sandbox iframe wires them up with an import map, so the
 * browser fetches + parses ONE React across every app and every reload.
 *
 * `splitting: true` puts React (+ scheduler) in a shared chunk that every entry
 * imports — guaranteeing a SINGLE React instance even though `react`,
 * `react-dom/client`, the kit components, and the host bridge are separate
 * entry points.
 *
 * Output: `<outDir>/<name>-<hash>.js` files + `manifest.json`, a map from the
 * specifier as written in app source (`react`, `@/components/ui/button`, `@host`,
 * …) to its hashed URL. The sandbox reads the manifest to build the import map.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { KIT } from './kit.ts';

const REAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_NS = 'rt-entry';
const require = createRequire(import.meta.url);

/** Re-export EVERY public name a CJS package exposes as a static ESM named
 *  export. `export * from '<cjs>'` does NOT do this across the bundle boundary —
 *  the re-exports aren't statically visible to a SEPARATE build that imports the
 *  entry at runtime via the import map, so `import { createRoot }`/`{ useState }`
 *  come back undefined. We instead bind each name off the CJS default object,
 *  which esbuild's interop guarantees is the real module.exports. The name list
 *  comes from the actually-installed package, so it can't drift from the API. */
function reexportCjs(specifier: string, opts: { default?: boolean } = {}): string {
  const mod = require(specifier) as Record<string, unknown>;
  const names = Object.keys(mod).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
  const lines = [`import base from ${JSON.stringify(specifier)};`];
  if (opts.default) lines.push('export default base;');
  for (const n of names) lines.push(`export const ${n} = base[${JSON.stringify(n)}];`);
  return lines.join('\n') + '\n';
}

/** Each shared module, by entry name → its source. The react* entries re-export
 *  the real packages; esbuild splitting collapses the actual React into one
 *  shared chunk. The kit + host sources are the SAME strings apps used to bundle
 *  (kit.ts), so there is no second source of truth. */
const ENTRY_SRC: Record<string, string> = {
  react: reexportCjs('react', { default: true }),
  'react-dom': reexportCjs('react-dom', { default: true }),
  'react-dom-client': reexportCjs('react-dom/client'),
  'jsx-runtime': reexportCjs('react/jsx-runtime'),
  utils: KIT['@/lib/utils']!,
  button: KIT['@/components/ui/button']!,
  card: KIT['@/components/ui/card']!,
  input: KIT['@/components/ui/input']!,
  label: KIT['@/components/ui/label']!,
  badge: KIT['@/components/ui/badge']!,
  separator: KIT['@/components/ui/separator']!,
  host: KIT['@host']!,
};

/** Specifier as written in app source → entry name. This is the contract the
 *  bundler (external list) and the sandbox (import map) both derive from. */
export const RUNTIME_SPECIFIERS: Record<string, string> = {
  react: 'react',
  'react-dom': 'react-dom',
  'react-dom/client': 'react-dom-client',
  'react/jsx-runtime': 'jsx-runtime',
  '@/lib/utils': 'utils',
  '@/components/ui/button': 'button',
  '@/components/ui/card': 'card',
  '@/components/ui/input': 'input',
  '@/components/ui/label': 'label',
  '@/components/ui/badge': 'badge',
  '@/components/ui/separator': 'separator',
  '@host': 'host',
};

/** esbuild plugin: serve the virtual entry sources + bind the kit's own
 *  `@/lib/utils` import to the same `utils` module (so `cn` isn't duplicated).
 *  Everything else (react, react-dom, scheduler) resolves from node_modules and
 *  is bundled — splitting dedupes React into a shared chunk. */
function runtimePlugin(): esbuild.Plugin {
  return {
    name: 'mantle-runtime',
    setup(build) {
      build.onResolve({ filter: /^entry:/ }, (args) => ({
        path: args.path.slice('entry:'.length),
        namespace: ENTRY_NS,
      }));
      build.onResolve({ filter: /^@\/lib\/utils$/ }, () => ({
        path: 'utils',
        namespace: ENTRY_NS,
      }));
      build.onLoad({ filter: /.*/, namespace: ENTRY_NS }, (args) => ({
        contents: ENTRY_SRC[args.path] ?? '',
        loader: 'tsx',
        resolveDir: REAL_DIR,
      }));
    },
  };
}

export type RuntimeManifest = {
  /** specifier (as imported in app code) → hashed URL under `/app-runtime/`. */
  imports: Record<string, string>;
  builtAt: string;
  esbuildVersion: string;
};

/**
 * Build the shared runtime into `outDir` and return the manifest. The caller is
 * responsible for where `outDir` lives (apps/web/public/app-runtime) and for the
 * public URL prefix (`/app-runtime/`).
 */
export async function buildRuntime(
  outDir: string,
  urlPrefix = '/app-runtime/',
): Promise<RuntimeManifest> {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const result = await esbuild.build({
    entryPoints: Object.keys(ENTRY_SRC).map((name) => ({ in: `entry:${name}`, out: name })),
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    minify: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    outdir: outDir,
    entryNames: '[name]-[hash]',
    chunkNames: 'chunk-[hash]',
    write: true,
    logLevel: 'silent',
    plugins: [runtimePlugin()],
  });
  void result;

  // Map each requested entry name → its hashed output file. esbuild names entry
  // outputs `<out>-<hash>.js`; the hash is alnum (no dashes), so the file for an
  // entry is the one whose basename is `<name>-<hash>.js` with no further dash —
  // which keeps `react` from matching `react-dom-client-<hash>.js`.
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.js'));
  const nameToFile: Record<string, string> = {};
  for (const name of Object.keys(ENTRY_SRC)) {
    const prefix = `${name}-`;
    nameToFile[name] = files.find(
      (f) => f.startsWith(prefix) && !f.slice(prefix.length, -'.js'.length).includes('-'),
    )!;
  }

  const imports: Record<string, string> = {};
  for (const [specifier, name] of Object.entries(RUNTIME_SPECIFIERS)) {
    const file = nameToFile[name];
    if (!file) throw new Error(`runtime build produced no output for entry '${name}'`);
    imports[specifier] = urlPrefix + file;
  }

  const manifest: RuntimeManifest = {
    imports,
    builtAt: new Date().toISOString(),
    esbuildVersion: esbuild.version,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
