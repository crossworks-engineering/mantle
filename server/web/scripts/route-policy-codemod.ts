/**
 * The route policy codemod (plan v3.2, run in part 1 of the route declarations): writes
 * each route file's policy declaration (`export const policy =
 * routePolicy({ ... })`, lib/auth/route-declaration.ts) from today's lists
 * (route-scope.ts, route-policy.ts, any-login-routes.ts, member-routes.ts,
 * auth-constants.ts PUBLIC_PATHS, api-v1.ts, route-limits.ts ROUTE_GATES),
 * as buildRouteRow reads them: the declaration of a method is its row's
 * (scripts/route-declarations.ts rowDeclaration).
 *
 * Before it writes anything it proves the declarations: every row built
 * from them (buildRoutePolicy, source 'declarations') is equal, field for
 * field, to the lists' row, and the generator reads each file's new text
 * back to the very declaration (route-callers.ts handlerPolicy). A route
 * the shape cannot say is named and nothing is written.
 *
 *   pnpm -C server/web exec tsx scripts/route-policy-codemod.ts            # --check
 *   ... --check      report what it would write (exit 1 when a file would change)
 *   ... --dry-run [dir]  write the would-be files under dir (a temp dir by default)
 *   ... --write      write the route files in place
 *   ... --verbose    print each file's declaration too
 *
 * Idempotent: a file whose declaration is already what the lists say is
 * left as it is, so a second run writes nothing. Run --write only on a
 * tree where no other branch edits route files (wave 5 of the plan).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { buildRoutePolicy, type RouteManifestEntry, type RouteRow } from '../lib/auth/route-policy';
import { ITEM_NONE_PLACEHOLDER, type RoutePolicyDeclaration } from '../lib/auth/route-declaration';
import { aliasMismatches, handlerPolicy } from './route-callers';
import {
  CannotExpress,
  applyDeclaration,
  entryDeclaration,
  renderDeclaration,
} from './route-declarations';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

type Mode = 'check' | 'dry-run' | 'write';

function parseArgs(argv: readonly string[]): { mode: Mode; dir: string | null; verbose: boolean } {
  let mode: Mode = 'check';
  let dir: string | null = null;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--check') mode = 'check';
    else if (a === '--write') mode = 'write';
    else if (a === '--verbose') verbose = true;
    else if (a === '--dry-run') {
      mode = 'dry-run';
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) dir = argv[++i]!;
    } else throw new Error(`route-policy-codemod: unknown argument ${a}`);
  }
  return { mode, dir, verbose };
}

/** Each row as plain data, for a field-for-field comparison. */
const plain = (row: RouteRow) => JSON.stringify(row);

async function main(): Promise<void> {
  const { mode, dir, verbose } = parseArgs(process.argv.slice(2));
  // The manifest of this tree, fresh: the generator reads every route file.
  execFileSync(
    process.execPath,
    [...process.execArgv, join(webRoot, 'scripts/gen-route-manifest.ts')],
    {
      cwd: webRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
  const { routeManifest } = (await import('../server/route-manifest.gen')) as {
    routeManifest: Array<RouteManifestEntry & { file: string }>;
  };
  const lists = buildRoutePolicy(routeManifest, { source: 'lists' });
  const patternByFile = new Map(routeManifest.map((e) => [e.file, e.pattern]));

  const cannot: string[] = [];
  const decls = new Map<string, RoutePolicyDeclaration>();
  for (const entry of routeManifest) {
    try {
      decls.set(entry.pattern, entryDeclaration(lists, entry));
    } catch (e) {
      if (!(e instanceof CannotExpress)) throw e;
      cannot.push(e.message);
    }
  }

  // The proof: every row from the declarations is the lists' row.
  let equal = 0;
  const differ: string[] = [];
  if (cannot.length === 0) {
    const declared = buildRoutePolicy(
      routeManifest.map((e) => ({ ...e, policy: decls.get(e.pattern) })),
      { source: 'declarations' },
    );
    for (const [key, row] of lists) {
      const got = declared.get(key);
      if (got && plain(got) === plain(row)) equal += 1;
      else differ.push(key);
    }
    if (declared.size !== lists.size) differ.push(`(${declared.size} rows, not ${lists.size})`);
  }

  // Nothing is written unless every row is proven.
  const blocked = cannot.length > 0 || differ.length > 0;
  const out =
    mode === 'dry-run' && !blocked ? (dir ?? mkdtempSync(join(tmpdir(), 'route-policy-'))) : null;
  let declarations = 0;
  let placeholders = 0;
  // Every file's new text first; nothing is written until each is built,
  // proven idempotent and read back (a failure leaves no file half done).
  const changed: Array<{ file: string; abs: string; next: string }> = [];
  for (const entry of routeManifest) {
    const decl = decls.get(entry.pattern);
    if (!decl) continue;
    declarations += Object.keys(decl).length;
    for (const p of Object.values(decl)) {
      if (p?.item && 'none' in p.item && p.item.none === ITEM_NONE_PLACEHOLDER) placeholders += 1;
    }
    const abs = join(webRoot, entry.file);
    const src = readFileSync(abs, 'utf8');
    const statement = renderDeclaration(decl);
    const config = (await resolveConfig(abs)) ?? {};
    const next = await format(applyDeclaration(src, entry.file, statement), {
      ...config,
      filepath: abs,
    });
    // Idempotent, and read back by the generator as written.
    const again = await format(applyDeclaration(next, entry.file, statement), {
      ...config,
      filepath: abs,
    });
    if (again !== next) throw new Error(`${entry.file}: a second run would change it again`);
    const read = handlerPolicy(next, entry.file, entry);
    if (JSON.stringify(read) !== JSON.stringify(decl)) {
      throw new Error(`${entry.file}: the generator reads another declaration back`);
    }
    // Each alias is the route file its handler is re-exported from (the
    // generator's check too, gen-route-manifest.ts).
    const aliases = aliasMismatches(next, entry.file, read, (spec) => {
      if (!spec.startsWith('.')) return null;
      const target = relative(webRoot, resolve(dirname(abs), spec))
        .split(sep)
        .join('/');
      return patternByFile.get(`${target}.ts`) ?? patternByFile.get(`${target}.tsx`) ?? null;
    });
    if (aliases.length) throw new Error(aliases.join('; '));
    if (next === src) continue;
    changed.push({ file: entry.file, abs, next });
    if (verbose) console.log(`${entry.file}\n${statement}\n`);
  }
  if (!blocked) {
    for (const c of changed) {
      if (mode === 'write') writeFileSync(c.abs, c.next);
      if (out) {
        const to = join(out, 'server/web', c.file);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, c.next);
      }
    }
  }

  console.log(
    [
      `[route-policy-codemod] ${mode}`,
      `  route files:   ${routeManifest.length}`,
      `  rows:          ${lists.size}`,
      `  declarations:  ${declarations} (methods declared; a HEAD the GET handler answers takes its GET's)`,
      `  rows equal:    ${equal} of ${lists.size}`,
      `  item none, placeholder reason: ${placeholders} (methods; ITEM_NONE_PLACEHOLDER)`,
      `  files to write: ${changed.length}${mode === 'write' && !blocked ? ' (written)' : ''}`,
      ...(out ? [`  written under: ${out}`] : []),
      ...(cannot.length ? ['  cannot express:', ...cannot.map((c) => `    ${c}`)] : []),
      ...(differ.length ? ['  rows not equal:', ...differ.map((k) => `    ${k}`)] : []),
    ].join('\n'),
  );
  if (blocked) process.exit(2);
  if (mode === 'check' && changed.length) process.exit(1);
}

await main();
