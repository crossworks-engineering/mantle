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
import { parse, type ParserPlugin } from '@babel/parser';
import esbuild, { type BuildOptions, type Message, type Plugin } from 'esbuild';
import { buildAppCss } from './css';
import { KIT } from './kit';
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

/** Bare npm packages a mini app may import. Everything else is rejected. */
const BARE_ALLOW = /^(react($|\/)|react-dom($|\/)|lucide-react($|\/))/;

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

/** Wrappers esbuild strips before it reads a call: TypeScript casts,
 *  non-null marks and type arguments (`(require as any)(…)`, `require!(…)`,
 *  `(require<any>)(…)`), and parentheses. */
const TRANSPARENT = new Set([
  'TSInstantiationExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'ParenthesizedExpression',
]);

function unwrap(node: unknown): Record<string, unknown> | undefined {
  let n = node as Record<string, unknown> | undefined;
  while (n && typeof n.type === 'string' && TRANSPARENT.has(n.type)) {
    n = n.expression as Record<string, unknown> | undefined;
  }
  return n;
}

/** What a call's argument must be for esbuild to resolve it through the
 *  plugin gates: one plain string, or a template with no substitution. */
function isPlainPath(arg: unknown): boolean {
  const a = unwrap(arg);
  if (!a) return false;
  if (a.type === 'StringLiteral') return true;
  if (a.type === 'TemplateLiteral') return ((a.expressions as unknown[]) ?? []).length === 0;
  return false;
}

/** `require` as a callee, also when wrapped: `(0, require)`, `(require)`, a cast. */
function isRequireCallee(callee: unknown): boolean {
  const c = unwrap(callee);
  if (!c) return false;
  if (c.type === 'Identifier') return c.name === 'require';
  if (c.type === 'SequenceExpression') {
    const exprs = (c.expressions as unknown[]) ?? [];
    return isRequireCallee(exprs[exprs.length - 1]);
  }
  return false;
}

/** Keys of a Babel node that hold no code. */
const NOT_CODE = new Set([
  'type',
  'start',
  'end',
  'loc',
  'range',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'tokens',
]);

/** The first `import()` or `require()` in a parsed module whose argument is
 *  not a plain path, or null. The tree is the app's own source as written,
 *  so neither quote style, regular expressions, comments, template nesting
 *  nor dead code (`if (false) require(…)`, which the bundler still expands)
 *  can hide a call (the M2's probe and the audit of 2026-10-24). */
function computedCall(ast: unknown): 'import' | 'require' | null {
  const stack: unknown[] = [ast];
  while (stack.length) {
    const node = stack.pop() as Record<string, unknown> | null;
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'ImportExpression' && !isPlainPath(node.source)) return 'import';
    // An optional call (`require?.(…)`) is not expanded by esbuild today; it
    // is checked the same way, so a later esbuild cannot open a gap.
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callee = unwrap(node.callee);
      const args = (node.arguments as unknown[]) ?? [];
      if (callee?.type === 'Import' && !isPlainPath(args[0])) return 'import';
      if (isRequireCallee(callee) && (args.length === 0 || !isPlainPath(args[0]))) return 'require';
    }
    for (const key of Object.keys(node)) {
      if (NOT_CODE.has(key)) continue;
      const v = node[key];
      // One at a time: a spread of a huge array (10^5 statements) throws.
      if (Array.isArray(v)) for (const item of v) stack.push(item);
      else if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

/** The Babel syntax plugins for an app file's loader: the language as
 *  written, TypeScript and JSX included, with no transform in between. */
function parserPlugins(loader: string): ParserPlugin[] {
  if (loader === 'tsx') return ['typescript', 'jsx', 'decorators-legacy'];
  if (loader === 'ts') return ['typescript', 'decorators-legacy'];
  return ['jsx', ['decorators', {}]];
}

/**
 * Refuse an `import()` or `require()` with a computed path before esbuild
 * runs. esbuild expands one (`require(\`./${x}\`)`, `'./' + x`) by reading the
 * matching files on the real disk itself, with no onResolve call, so the
 * plugin gates never see them, and a file that fails to parse is quoted in
 * the error (audit 2026-10-24). Each app file is parsed AS WRITTEN (Babel,
 * TypeScript and JSX), not through a transform, which folds constants and
 * drops dead code the bundler still expands. A file the parser cannot read
 * is refused with the parser's own message: the check fails closed.
 */
async function computedImportErrors(source: AppSource): Promise<BuildMessage[]> {
  const out: BuildMessage[] = [];
  for (const [file, text] of Object.entries(source.files)) {
    const loader = loaderFor(file);
    if (!CODE_LOADERS.has(loader)) continue;
    let ast: unknown;
    try {
      ast = parse(text, {
        sourceType: 'module',
        sourceFilename: file,
        plugins: parserPlugins(loader),
        createImportExpressions: true,
        errorRecovery: false,
      });
    } catch (err) {
      // About the app's own source, so it goes back as it is.
      const e = err as { message?: string; loc?: { line: number; column: number } };
      out.push({
        text: `This file could not be checked for computed imports, so the build is refused: ${e.message ?? 'unreadable'}`,
        location: { file, line: e.loc?.line ?? 0, column: e.loc?.column ?? 0 },
      });
      continue;
    }
    const kind = computedCall(ast);
    if (kind) {
      out.push({
        text: `${kind}() in a mini app takes one quoted path, like ${kind}('./Chart'). A computed path (a variable, a template string or a joined string) is not allowed.`,
        location: { file, line: 0, column: 0 },
      });
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

/** esbuild's messages about reading a file off the disk. One can sit at an
 *  app file (a glob's read error is located at the call), so these are
 *  generic wherever they are located (the audits of 2026-10-24). */
const DISK_READ_RE = /Cannot read (file|directory)|No loader is configured|Could not read/;
/** A path that climbs out or is absolute, quoted or not: `../x`, `/a/b`,
 *  `C:\\x`. Not `"/"` alone, which a plain syntax error quotes. */
const OUTSIDE_PATH_RE = /(?:^|[\s"'(:])(?:\.\.[\\/]|\/[^\s"'/]+\/|[A-Za-z]:[\\/])/;
const GENERIC_MSG = 'The build failed on a file that is not part of this app.';

/**
 * A build message the author may see. One about the app's own code (located
 * at `app:<key>`, or the stdin entry) keeps its text, so a warning such as a
 * duplicate key still helps; a disk-read message never does. Any other
 * message carries no text or path of a file that is not the app's: a failed
 * parse quotes the file (audit 2026-10-24).
 */
function appOnlyMsg(source: AppSource, m: Message): BuildMessage {
  if (DISK_READ_RE.test(m.text)) return { text: GENERIC_MSG, location: null };
  const file = m.location?.file;
  if (!file) {
    return OUTSIDE_PATH_RE.test(m.text) ? { text: GENERIC_MSG, location: null } : toMsg(m);
  }
  if (file === STDIN || file.endsWith(`/${STDIN}`)) return toMsg(m);
  // An app file is located as `app:<key>` (its namespace). A bare path that
  // merely equals a file key is a disk file, not the app's (the M2's C2).
  if (file.startsWith(`${APP_NS}:`) && Object.hasOwn(source.files, file.slice(APP_NS.length + 1))) {
    return toMsg(m);
  }
  if (path.resolve(file).startsWith(LUCIDE_ROOT + path.sep)) return toMsg(m);
  return { text: GENERIC_MSG, location: null };
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
        return {
          errors: [
            {
              text: `Unknown import '${args.path}'. Allowed: react, ${Object.keys(KIT).join(', ')}, lucide-react, and relative files.`,
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
        const refused = {
          errors: [
            {
              text: `Import '${args.path}' is not allowed in a mini app. Allowed packages: react, react-dom, lucide-react. Use @/components/ui/*, @host, or relative files for everything else.`,
            },
          ],
        };
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
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(text)) !== null) {
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
  return out;
}

/** Bundle an app's source tree into one self-mounting ESM module. When
 *  `declaredToolSlugs` is supplied, undeclared `host.tools.call` slugs are
 *  appended to the build's warnings (see lintToolRefs). */
export { loadRuntimeExports } from './runtime-exports';
export { buildCanvasCss } from './css';
export { CANVAS_MODULE_SPECIFIERS } from './canvas-runtime';

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
