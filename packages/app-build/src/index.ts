/**
 * The mini-app bundler. Takes an app's virtual source tree and produces a single
 * self-mounting ESM bundle for the sandbox iframe. React, the curated UI kit and
 * the host bridge are NOT bundled in — they're marked external and resolved at
 * runtime by an import map (see build-runtime.ts + app-sandbox.tsx), so one
 * shared React/kit is fetched + parsed ONCE across every app and reload instead
 * of re-bundled (~40 KB+) into each app. The app's output is just its own code
 * (+ any allowed npm like lucide-react, which tree-shakes small per app).
 *
 * Build inputs are agent-authored TSX; build errors are returned (not thrown)
 * with file/line locations so Appsmith can read them and self-correct.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild, { type BuildOptions, type Message, type Plugin } from 'esbuild';
import { KIT } from './kit';

/** Specifiers provided by the shared runtime via the iframe import map — marked
 *  external so they stay as bare imports in the app bundle. The react family is
 *  externalized GLOBALLY (below) so even a bundled dep's React (e.g. lucide's)
 *  resolves to the one shared instance; the `@`-prefixed kit/host specifiers are
 *  externalized per-import by the plugin (with an allowlist check). Keep this in
 *  sync with build-runtime.ts RUNTIME_SPECIFIERS. */
const REACT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'];

// A REAL directory inside this package, used as the esbuild resolveDir for the
// virtual entry + kit + app modules so bare imports (react, react-dom/client,
// react/jsx-runtime, lucide-react) resolve from this package's node_modules.
// The app/kit *sources* are still served from memory by the plugin; only bare
// package imports fall through to on-disk node_modules resolution.
const REAL_DIR = path.dirname(fileURLToPath(import.meta.url));

export type AppSource = { entry: string; files: Record<string, string> };

export type BuildMessage = {
  text: string;
  location: { file: string; line: number; column: number } | null;
};

export type BuildResult = {
  ok: boolean;
  /** Bundled ESM (present iff ok). */
  code?: string;
  errors: BuildMessage[];
  warnings: BuildMessage[];
  esbuildVersion: string;
};

export const ESBUILD_VERSION = esbuild.version;

const APP_NS = 'app';
const STDIN = '<stdin>';

/** Bare npm packages a mini app may import. Everything else is rejected. */
const BARE_ALLOW = /^(react($|\/)|react-dom($|\/)|lucide-react($|\/))/;

function loaderFor(p: string): 'tsx' | 'ts' | 'js' | 'jsx' | 'json' | 'css' {
  if (p.endsWith('.ts')) return 'ts';
  if (p.endsWith('.js')) return 'js';
  if (p.endsWith('.jsx')) return 'jsx';
  if (p.endsWith('.json')) return 'json';
  if (p.endsWith('.css')) return 'css';
  return 'tsx';
}

/** Normalize a key as it appears in `files` (posix, no leading ./). */
function normKey(k: string): string {
  return path.posix.normalize(k.replace(/^\.\//, '')).replace(/^\/+/, '');
}

/** Resolve a relative import against the source tree, trying common extensions
 *  and index files — mirrors how a bundler resolves `./x`. */
function resolveInTree(files: Record<string, string>, fromKey: string, importPath: string): string | null {
  const fromDir = fromKey === '<stdin>' ? '' : path.posix.dirname(fromKey);
  const base = normKey(path.posix.join(fromDir, importPath));
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    `${base}.json`,
    `${base}/index.tsx`,
    `${base}/index.ts`,
  ];
  for (const c of candidates) if (c in files) return c;
  return null;
}

function virtualPlugin(source: AppSource): Plugin {
  const files = source.files;
  return {
    name: 'mantle-app-virtual',
    setup(build) {
      // Kit + alias imports (@host, @/components/ui/*, @/lib/utils): marked
      // external (allowlisted) so they resolve from the shared runtime import
      // map at load time instead of being bundled into every app.
      build.onResolve({ filter: /^@/ }, (args) => {
        if (args.path in KIT) return { path: args.path, external: true };
        return {
          errors: [
            {
              text: `Unknown import '${args.path}'. Allowed: react, ${Object.keys(KIT).join(', ')}, lucide-react, and relative files.`,
            },
          ],
        };
      });

      // Relative imports — resolve against the virtual source tree. The stdin
      // entry's `import App from './<entry>'` also lands here (its importer is
      // the resolved stdin path, e.g. '/.../app-build/src/<stdin>').
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        const isStdin = args.importer === STDIN || args.importer.endsWith(`/${STDIN}`);
        if (args.namespace !== APP_NS && !isStdin) return null;
        const fromKey = args.namespace === APP_NS ? args.importer : STDIN;
        const key = resolveInTree(files, fromKey, args.path);
        if (!key) {
          return { errors: [{ text: `Cannot resolve '${args.path}' from '${fromKey}'` }] };
        }
        return { path: key, namespace: APP_NS };
      });

      // Bare package imports (not relative, not @-prefixed). Only the curated
      // runtime packages are allowed; everything else (node:*, arbitrary npm)
      // is rejected with a clear message so Appsmith self-corrects. The iframe
      // sandbox + CSP is the real boundary, but failing the build is cleaner
      // feedback than a silently dead import.
      build.onResolve({ filter: /^[^.@]/ }, (args) => {
        // Only gate imports written in USER/KIT source — let transitive
        // node_modules imports (react-dom → scheduler, etc.) resolve freely.
        const fromUserCode =
          args.namespace === APP_NS ||
          args.importer === STDIN ||
          args.importer.endsWith(`/${STDIN}`);
        if (!fromUserCode) return null;
        if (BARE_ALLOW.test(args.path)) return null; // fall through to node_modules
        return {
          errors: [
            {
              text: `Import '${args.path}' is not allowed in a mini app. Allowed packages: react, react-dom, lucide-react. Use @/components/ui/*, @host, or relative files for everything else.`,
            },
          ],
        };
      });

      build.onLoad({ filter: /.*/, namespace: APP_NS }, (args) => {
        const contents = files[args.path];
        if (contents === undefined) {
          return { errors: [{ text: `Missing file '${args.path}'` }] };
        }
        return { contents, loader: loaderFor(args.path), resolveDir: REAL_DIR };
      });
    },
  };
}

function toMsg(m: Message): BuildMessage {
  return {
    text: m.text,
    location: m.location
      ? { file: m.location.file, line: m.location.line, column: m.location.column }
      : null,
  };
}

// Matches a `host.tools.call('slug', …)` site with a *literal* slug. Dynamic
// slugs (a variable) are intentionally not matched — we can't statically know
// them, and flagging them would be a false positive.
const TOOL_CALL_RE = /host\s*\.\s*tools\s*\.\s*call\s*\(\s*(['"`])([^'"`]+)\1/g;

/**
 * Static lint: find every `host.tools.call('<slug>')` whose slug isn't in the
 * app's declared `toolSlugs`. The host broker refuses undeclared slugs at
 * runtime (a 403 the user only sees when the call fires), so surfacing the
 * mismatch at build time turns a silent runtime failure into feedback the
 * agent (and the Build panel) sees immediately. Returns BuildMessages so the
 * caller can fold them into the build's warnings/errors. Literal slugs only.
 */
export function lintToolRefs(source: AppSource, declaredSlugs: string[]): BuildMessage[] {
  const declared = new Set(declaredSlugs);
  const out: BuildMessage[] = [];
  for (const [file, text] of Object.entries(source.files)) {
    TOOL_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOOL_CALL_RE.exec(text)) !== null) {
      const slug = m[2];
      if (!slug || declared.has(slug)) continue;
      const pre = text.slice(0, m.index);
      const line = pre.length - pre.replace(/\n/g, '').length + 1; // 1-based
      const column = m.index - (pre.lastIndexOf('\n') + 1); // 0-based within line
      out.push({
        text:
          `This app calls tool '${slug}' via host.tools.call, but '${slug}' isn't in the app's declared tools — ` +
          `the host will refuse it at runtime. Declare it with app_tools_set (build the tool via the toolsmith first if it doesn't exist), or remove the call.`,
        location: { file, line, column },
      });
    }
  }
  return out;
}

/** Bundle an app's source tree into one self-mounting ESM module. When
 *  `declaredToolSlugs` is supplied, undeclared `host.tools.call` slugs are
 *  appended to the build's warnings (see lintToolRefs). */
export async function buildApp(
  source: AppSource,
  opts: { declaredToolSlugs?: string[] } = {},
): Promise<BuildResult> {
  const toolWarnings = opts.declaredToolSlugs
    ? lintToolRefs(source, opts.declaredToolSlugs)
    : [];
  const withToolWarnings = (r: BuildResult): BuildResult =>
    toolWarnings.length ? { ...r, warnings: [...r.warnings, ...toolWarnings] } : r;
  return withToolWarnings(await buildAppInner(source));
}

async function buildAppInner(source: AppSource): Promise<BuildResult> {
  const entry = normKey(source.entry || 'App.tsx');
  if (!(entry in source.files)) {
    return {
      ok: false,
      errors: [{ text: `Entry file '${entry}' not found in source`, location: null }],
      warnings: [],
      esbuildVersion: ESBUILD_VERSION,
    };
  }

  const stdin = `import App from ${JSON.stringify('./' + entry)};\nimport { __mount } from '@host';\n__mount(App);\n`;

  const options: BuildOptions = {
    stdin: { contents: stdin, resolveDir: REAL_DIR, sourcefile: STDIN, loader: 'tsx' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    // React (incl. any bundled dep's React, e.g. lucide-react) resolves to the
    // one shared runtime instance via the iframe import map — never re-bundled.
    external: REACT_EXTERNALS,
    write: false,
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [virtualPlugin(source)],
  };

  try {
    const res = await esbuild.build(options);
    const code = res.outputFiles?.[0]?.text;
    return {
      ok: !!code,
      ...(code ? { code } : {}),
      errors: res.errors.map(toMsg),
      warnings: res.warnings.map(toMsg),
      esbuildVersion: ESBUILD_VERSION,
    };
  } catch (err) {
    // esbuild throws a BuildFailure carrying structured errors/warnings.
    const bf = err as { errors?: Message[]; warnings?: Message[] };
    if (bf && Array.isArray(bf.errors)) {
      return {
        ok: false,
        errors: bf.errors.map(toMsg),
        warnings: (bf.warnings ?? []).map(toMsg),
        esbuildVersion: ESBUILD_VERSION,
      };
    }
    return {
      ok: false,
      errors: [{ text: err instanceof Error ? err.message : String(err), location: null }],
      warnings: [],
      esbuildVersion: ESBUILD_VERSION,
    };
  }
}
