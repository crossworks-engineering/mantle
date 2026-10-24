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
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild, { type BuildOptions, type Message, type Plugin } from 'esbuild';
import { buildAppCss } from './css';
import { KIT } from './kit';
import { APP_LIBRARIES_LEFT_OUT, APP_LIBRARY_SPECIFIERS } from './app-libraries';
// Local copy of @mantle/std's errorMessage. This package is published as a
// contract package; it must not depend on private workspace packages, which
// do not exist on npm (the v0.232.122-153 tarballs shipped an unresolvable
// @mantle/std@0.0.1 dependency for exactly this import).
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  /** Compiled per-app Tailwind utilities (see css.ts). Absent when the CSS
   *  compile failed — the app then renders on the host stylesheet alone. */
  css?: string;
  errors: BuildMessage[];
  warnings: BuildMessage[];
  esbuildVersion: string;
};

export const ESBUILD_VERSION = esbuild.version;

const APP_NS = 'app';
/** Marks the bundler's own nested resolve, so the gate does not re-enter. */
const RESOLVING = Symbol('app-build-resolving');
const STDIN = '<stdin>';

/** Bare npm packages a mini app may import and bundle. Everything else is
 *  rejected, except the exact library specifiers below. */
const BARE_ALLOW = /^(react($|\/)|react-dom($|\/)|lucide-react($|\/))/;

/** The vendored libraries (app-libraries.ts): EXACT specifiers, left bare for
 *  the frame's import map, never bundled, so the build never reads them.
 *  `echarts/core` is not `echarts`. */
const LIBRARY_EXTERNALS = new Set(APP_LIBRARY_SPECIFIERS);

const ALLOWED_TEXT =
  `react, react-dom, lucide-react, and the libraries ${APP_LIBRARY_SPECIFIERS.join(', ')} ` +
  `(call canvas_library first)`;

/** A library import stays bare for the import map. It takes no import
 *  attribute: none means anything for a library module, and the @-scoped
 *  ones resolve before the attribute gate (audit 2026-10-24). */
function libraryImport(args: { path: string; with?: Record<string, string> }) {
  if (args.with && Object.keys(args.with).length) {
    return {
      errors: [{ text: `Import '${args.path}' takes no import attribute in a mini app.` }],
    };
  }
  return { path: args.path, external: true };
}

/** The refusal for a bare import, naming the fix when it is a known one. */
function refusal(spec: string): string {
  const why = APP_LIBRARIES_LEFT_OUT[spec];
  if (why)
    return `Import '${spec}' is not available in a mini app: ${why}. Allowed: ${ALLOWED_TEXT}.`;
  return `Import '${spec}' is not allowed in a mini app. Allowed packages: ${ALLOWED_TEXT}. Use @/components/ui/*, @host, or relative files for everything else.`;
}

/** The installed directories of the allowed packages: whatever an allowed
 *  bare import resolves to must lie inside one of them. */
const BUNDLED_PACKAGES = ['react', 'react-dom', 'lucide-react'];

/** A specifier that steps out of its package (`lucide-react/../x`, a `.`
 *  segment, an empty segment, a backslash) or carries a query or hash. The
 *  prefix match above passed `lucide-react/../../package.json` to node
 *  resolution, which read a file of the server's disk into the app bundle
 *  (security audit 2026-10-24). */
function escapesPackage(spec: string): boolean {
  if (/[\\?#]/.test(spec)) return true;
  return spec.split('/').some((seg) => seg === '.' || seg === '..' || seg === '');
}

/** An import attribute other than JSON (`with { type: 'text' }` and the
 *  like) makes esbuild read any file as text or bytes: user code may not
 *  ask for one. */
function refusedAttributes(attrs: Record<string, string> | undefined): string | null {
  if (!attrs) return null;
  for (const [k, v] of Object.entries(attrs)) {
    if (!(k === 'type' && v === 'json')) return `${k}: '${v}'`;
  }
  return null;
}

function fromUserSource(args: { namespace: string; importer: string }): boolean {
  return (
    args.namespace === APP_NS || args.importer === STDIN || args.importer.endsWith(`/${STDIN}`)
  );
}

function loaderFor(p: string): 'tsx' | 'ts' | 'js' | 'jsx' | 'json' | 'css' {
  if (p.endsWith('.ts')) return 'ts';
  if (p.endsWith('.js')) return 'js';
  if (p.endsWith('.jsx')) return 'jsx';
  if (p.endsWith('.json')) return 'json';
  if (p.endsWith('.css')) return 'css';
  return 'tsx';
}

/** The one package a build reads from disk (react and react-dom are
 *  external), by its real directory, so a folder that is merely NAMED
 *  `node_modules/lucide-react` elsewhere does not pass (audit 2026-10-24). */
const LUCIDE_ROOT = fs.realpathSync(
  path.dirname(createRequire(import.meta.url).resolve('lucide-react/package.json')),
);

/** Code an app may hold: what esbuild parses as a module. */
const CODE_LOADERS = new Set(['tsx', 'ts', 'jsx', 'js']);

/** A call esbuild expands into a read of the real disk: `import(` or
 *  `require(` whose argument is not one plain string. */
const CALL_RE = /(?<![\w$.])(import|require)\s*\(/g;
const PLAIN_ARG_RE = /^\s*"(?:[^"\\\n]|\\.)*"\s*[,)]/;

/**
 * Refuse an `import()` or `require()` with a computed path before esbuild
 * runs. esbuild expands one (`require(\`./${x}\`)`, `'./' + x`) by reading the
 * matching files on the real disk itself, with no onResolve call, so the
 * plugin gates never see them, and a file that fails to parse is quoted in
 * the error (audit 2026-10-24). Each file is first put through esbuild's own
 * transform, which prints plain JavaScript: identifier escapes
 * (`require`), comments and constant joins (`'./' + 'x'`) are gone, so the
 * scan reads what the bundler will.
 */
async function computedImportErrors(source: AppSource): Promise<BuildMessage[]> {
  const out: BuildMessage[] = [];
  for (const [file, text] of Object.entries(source.files)) {
    const loader = loaderFor(file);
    if (!CODE_LOADERS.has(loader)) continue;
    let code: string;
    try {
      code = (
        await esbuild.transform(text, {
          loader: loader as 'tsx' | 'ts' | 'jsx' | 'js',
          jsx: 'automatic',
          minifySyntax: true,
          legalComments: 'none',
          target: 'es2020',
        })
      ).code;
    } catch {
      continue; // a syntax error: the build reports it, and reads nothing
    }
    // esbuild prints every plain string in double quotes: empty them, so
    // text an app shows ("call require(x)") is not read as a call. A quoted
    // path stays a quoted path ("").
    code = code.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(code)) !== null) {
      if (PLAIN_ARG_RE.test(code.slice(m.index + m[0].length))) continue;
      out.push({
        text: `${m[1]}() in a mini app takes one quoted path, like ${m[1]}('./Chart'). A computed path (a template string or a joined string) is not allowed.`,
        location: { file, line: 0, column: 0 },
      });
      break;
    }
  }
  return out;
}

/** Every file a build read that is neither an app file (the virtual
 *  namespace), the stdin entry, nor inside lucide-react's real directory.
 *  The backstop behind computedImportErrors. */
function inputsOutsideTheApp(inputs: Record<string, unknown>): string[] {
  return Object.keys(inputs).filter(
    (p) =>
      !p.startsWith(`${APP_NS}:`) &&
      p !== STDIN &&
      !p.endsWith(`/${STDIN}`) &&
      !path.resolve(p).startsWith(LUCIDE_ROOT + path.sep),
  );
}

/** A message about a file that is not the app's own carries no text or
 *  path of it: a failed parse quotes the file (audit 2026-10-24). */
function appOnlyMsg(source: AppSource, m: Message): BuildMessage {
  const file = m.location?.file;
  if (!file || file === STDIN || file.endsWith(`/${STDIN}`)) return toMsg(m);
  const key = file.startsWith(`${APP_NS}:`) ? file.slice(APP_NS.length + 1) : file;
  if (Object.hasOwn(source.files, key)) return toMsg(m);
  if (path.resolve(file).startsWith(LUCIDE_ROOT + path.sep)) return toMsg(m);
  return { text: 'The build failed on a file that is not part of this app.', location: null };
}

/** Normalize a key as it appears in `files` (posix, no leading ./). */
function normKey(k: string): string {
  return path.posix.normalize(k.replace(/^\.\//, '')).replace(/^\/+/, '');
}

/** Resolve a relative import against the source tree, trying common extensions
 *  and index files — mirrors how a bundler resolves `./x`. */
function resolveInTree(
  files: Record<string, string>,
  fromKey: string,
  importPath: string,
): string | null {
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
  for (const c of candidates) if (Object.hasOwn(files, c)) return c;
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
        if (LIBRARY_EXTERNALS.has(args.path)) return libraryImport(args);
        return {
          errors: [
            {
              text: `Unknown import '${args.path}'. Allowed: ${Object.keys(KIT).join(', ')}, ${ALLOWED_TEXT}, and relative files.`,
            },
          ],
        };
      });

      // Every import written in user or kit source: no import attribute but
      // JSON, and never the bare `.` or `..` (they resolve against this
      // package's own directory on disk).
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.pluginData === RESOLVING || !fromUserSource(args)) return undefined;
        const attr = refusedAttributes(args.with);
        if (attr) {
          return {
            errors: [
              { text: `Import '${args.path}' with { ${attr} } is not allowed in a mini app.` },
            ],
          };
        }
        if (/^\.\.?([?#]|$)/.test(args.path)) {
          return { errors: [{ text: `Import '${args.path}' is not allowed in a mini app.` }] };
        }
        return undefined;
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
      build.onResolve({ filter: /^[^.@]/ }, async (args) => {
        // The backstop's own resolve call below comes back through here.
        if (args.pluginData === RESOLVING) return null;
        // Only gate imports written in USER/KIT source — let transitive
        // node_modules imports (react-dom → scheduler, etc.) resolve freely.
        if (!fromUserSource(args)) return null;
        const refused = { errors: [{ text: refusal(args.path) }] };
        // A vendored library: bare in the output, the import map serves it.
        if (LIBRARY_EXTERNALS.has(args.path)) return libraryImport(args);
        if (!BARE_ALLOW.test(args.path) || escapesPackage(args.path)) return refused;
        // Backstop: resolve it here, and keep it only when it lands inside
        // the package it names (a symlink or an odd `exports` map aside).
        const pkg = BUNDLED_PACKAGES.find((p) => args.path === p || args.path.startsWith(`${p}/`))!;
        const resolved = await build.resolve(args.path, {
          kind: args.kind,
          resolveDir: args.resolveDir,
          pluginData: RESOLVING,
        });
        if (resolved.errors.length) return { errors: resolved.errors };
        if (
          !resolved.external &&
          !resolved.path.includes(`${path.sep}node_modules${path.sep}${pkg}${path.sep}`)
        ) {
          return refused;
        }
        return resolved;
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

/** `import <what> from "<spec>"` — captures the clause and the specifier.
 *  Covers the three ESM shapes esbuild leaves external: default, namespace,
 *  and named (including a default+named combination). */
const IMPORT_RE = /import\s+([^'";]+?)\s+from\s*['"]([^'"]+)['"]/g;

/** A re-export links like an import: `export { a } from 'm'`,
 *  `export type { A } from 'm'`, `export * as ns from 'm'`. Only these exact
 *  shapes (the clause runs to `from` with nothing between), so an `export`
 *  statement without a `from` never reaches over to a later import.
 *  `export * from 'm'` names nothing and is left alone. */
const REEXPORT_RE =
  /export\s+((?:type\s*)?\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g;

/** `import type …` — the whole clause is type-only. Lookahead keeps
 *  `import type from 'm'` and `import type, { a } from 'm'` (a default import
 *  that happens to be NAMED `type`) as value imports. */
const TYPE_ONLY_CLAUSE_RE = /^type(?=\s*[{*]|\s+[A-Za-z_$])/;

/** `{ type X }` / `{ type X as Y }` — one type-only specifier. `{ type }` and
 *  `{ type as t }` import a value named `type` and stay checked. */
const TYPE_ONLY_SPECIFIER_RE = /^type\s+(?!as\b)[A-Za-z_$]/;

/** Split an import clause into the names it binds FROM the module.
 *  `Foo`               → default
 *  `* as ns`           → namespace (binds nothing by name; nothing to check)
 *  `{ a, b as c }`     → a, b
 *  `Foo, { a }`        → default, a
 *  `type { A }`        → nothing (type-only)
 *  `{ type A, b }`     → b
 *  Returns the names as the MODULE must provide them, not the local aliases.
 *  Type-only imports and specifiers are skipped: the compiler erases them, so
 *  they never reach the runtime and cannot fail to link. */
function importedNames(clause: string): { names: string[]; namespace: boolean } {
  const names: string[] = [];
  let namespace = false;
  if (TYPE_ONLY_CLAUSE_RE.test(clause)) return { names, namespace };
  const braced = clause.match(/\{([^}]*)\}/);
  const head = clause
    .slice(0, braced ? clause.indexOf('{') : undefined)
    .replace(/,\s*$/, '')
    .trim();
  if (head) {
    if (/^\*\s+as\s+/.test(head)) namespace = true;
    else if (/^[A-Za-z_$][\w$]*$/.test(head)) names.push('default');
  }
  if (braced) {
    for (const part of braced[1]!.split(',')) {
      if (TYPE_ONLY_SPECIFIER_RE.test(part.trim())) continue;
      const name = (part.split(/\s+as\s+/)[0] ?? '').trim();
      if (name) names.push(name);
    }
  }
  return { names, namespace };
}

/**
 * Static lint: every import of a SHARED RUNTIME specifier must name something
 * that specifier actually exports.
 *
 * These specifiers are external — esbuild leaves them as bare imports for the
 * sandbox's import map to resolve, so it never checks their shape, and a wrong
 * name survives into a clean, publishable build. The browser then rejects the
 * module while LINKING, before any code runs: no ErrorBoundary can catch it
 * (there is nothing to render yet) and the app never signals ready, so the
 * sandbox can only time out with a generic failure. `import host from '@host'`
 * — where the export is named, not default — cost exactly that in the field:
 * a green build, then a twenty-second spinner and "couldn't load the app".
 *
 * Errors, not warnings: the app is guaranteed not to run.
 *
 * Local/relative imports are the bundler's business and are skipped, as is a
 * namespace import (`* as ns`), which binds no names and cannot mismatch, and
 * any type-only import or specifier, which the compiler erases.
 */
export function lintRuntimeImports(
  source: AppSource,
  runtimeExports: Record<string, string[]>,
): BuildMessage[] {
  const out: BuildMessage[] = [];
  for (const [file, text] of Object.entries(source.files)) {
    for (const re of [IMPORT_RE, REEXPORT_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const spec = m[2]!;
        if (spec.startsWith('.') || spec.startsWith('/')) continue;
        const available = runtimeExports[spec];
        if (!available) continue; // not a shared-runtime specifier; esbuild will rule on it
        const { names, namespace } = importedNames(m[1]!);
        if (namespace) continue;
        const have = new Set(available);
        for (const name of names) {
          if (have.has(name)) continue;
          const pre = text.slice(0, m.index);
          const line = pre.length - pre.replace(/\n/g, '').length + 1; // 1-based
          const column = m.index - (pre.lastIndexOf('\n') + 1); // 0-based within line
          const hint =
            name === 'default'
              ? `'${spec}' has no default export. Use a named import, e.g. import { ${available[0]} } from '${spec}'.`
              : `'${spec}' does not export '${name}'.`;
          out.push({
            text: `${hint} It exports: ${available.join(', ')}. Left as-is the app builds but fails to load in the browser, with no error the app can catch.`,
            location: { file, line, column },
          });
        }
      }
    }
  }
  return out;
}

/** Bundle an app's source tree into one self-mounting ESM module. When
 *  `declaredToolSlugs` is supplied, undeclared `host.tools.call` slugs are
 *  appended to the build's warnings (see lintToolRefs). */
export { loadRuntimeExports } from './runtime-exports';
export { buildCanvasCss } from './css';
export { CANVAS_MODULE_SPECIFIERS } from './canvas-runtime';
export {
  APP_CANVAS_LIBRARIES,
  APP_LIBRARIES_LEFT_OUT,
  APP_LIBRARY_SPECIFIERS,
  APP_RUNTIME_LIBRARIES,
} from './app-libraries';

export async function buildApp(
  source: AppSource,
  opts: {
    declaredToolSlugs?: string[];
    /** The shared runtime's export map (`loadRuntimeExports()` in production).
     *  REQUIRED so the import check below cannot be skipped by forgetting it —
     *  an app that fails this check cannot run at all, so silently omitting the
     *  check would ship a guaranteed-broken app. */
    runtimeExports: Record<string, string[]>;
  },
): Promise<BuildResult> {
  // Runtime-import mismatches are fatal and cheap to detect, so they short
  // circuit ahead of esbuild: no point compiling an app that cannot link.
  const importErrors = lintRuntimeImports(source, opts.runtimeExports);
  if (importErrors.length) {
    return { ok: false, errors: importErrors, warnings: [], esbuildVersion: ESBUILD_VERSION };
  }
  // Before esbuild, which would read the disk for a computed import.
  const computedErrors = await computedImportErrors(source);
  if (computedErrors.length) {
    return { ok: false, errors: computedErrors, warnings: [], esbuildVersion: ESBUILD_VERSION };
  }
  const toolWarnings = opts.declaredToolSlugs ? lintToolRefs(source, opts.declaredToolSlugs) : [];
  const withToolWarnings = (r: BuildResult): BuildResult =>
    toolWarnings.length ? { ...r, warnings: [...r.warnings, ...toolWarnings] } : r;
  const result = withToolWarnings(await buildAppInner(source));
  if (!result.ok) return result;
  // CSS after a green JS build only. A CSS failure is OUR bug (the app's
  // classes can't be invalid — unknown ones are just dropped), so it degrades
  // to a warning + no css, never a red build.
  try {
    return { ...result, css: await buildAppCss(source) };
  } catch (err) {
    return {
      ...result,
      warnings: [
        ...result.warnings,
        {
          text: `app CSS compile failed (${errorMessage(err)}); the app will rely on the host stylesheet`,
          location: null,
        },
      ],
    };
  }
}

async function buildAppInner(source: AppSource): Promise<BuildResult> {
  const entry = normKey(source.entry || 'App.tsx');
  if (!Object.hasOwn(source.files, entry)) {
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
    metafile: true,
    plugins: [virtualPlugin(source)],
  };

  const appMsg = (m: Message) => appOnlyMsg(source, m);
  try {
    const res = await esbuild.build(options);
    if (inputsOutsideTheApp(res.metafile?.inputs ?? {}).length) {
      return {
        ok: false,
        // No path: it would tell the author which files exist off the app.
        errors: [
          {
            text: 'The build read a file that is not part of this app. An import() or require() in a mini app takes one quoted path: a computed path (a template string or a joined string) is not allowed.',
            location: null,
          },
        ],
        warnings: res.warnings.map(appMsg),
        esbuildVersion: ESBUILD_VERSION,
      };
    }
    const code = res.outputFiles?.[0]?.text;
    return {
      ok: !!code,
      ...(code ? { code } : {}),
      errors: res.errors.map(appMsg),
      warnings: res.warnings.map(appMsg),
      esbuildVersion: ESBUILD_VERSION,
    };
  } catch (err) {
    // esbuild throws a BuildFailure carrying structured errors/warnings.
    const bf = err as { errors?: Message[]; warnings?: Message[] };
    if (bf && Array.isArray(bf.errors)) {
      return {
        ok: false,
        errors: bf.errors.map(appMsg),
        warnings: (bf.warnings ?? []).map(appMsg),
        esbuildVersion: ESBUILD_VERSION,
      };
    }
    return {
      ok: false,
      errors: [{ text: errorMessage(err), location: null }],
      warnings: [],
      esbuildVersion: ESBUILD_VERSION,
    };
  }
}
