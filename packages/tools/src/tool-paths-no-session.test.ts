/**
 * No tool path reads the HTTP session (A5 step 3b fix round 1, LOW-4).
 *
 * Inside a gated tool call, currentCaller() is the tool's gate caller (an
 * app broker's, the dev console's, a turn's), not the HTTP pipeline's. The
 * session readers of server/web/lib/auth (session.ts: ownerCaller and the
 * other caller readers, the asset and session guards, the pipeline's answer
 * behind them) read the pipeline's, so one reached from a tool call would
 * throw, or answer for the wrong caller. A tool's code is the packages':
 * every builtin handler is registered from packages (the policy table,
 * @mantle/runtime's heartbeat tools), and server/web registers none. So:
 *
 *  - no source file of a package (packages/{tools,runtime} and every
 *    package they reach) imports @/lib/auth, @/lib/auth/session, or any
 *    module of server/web (a relative path into it, or one that names it);
 *  - no non-test module of server/web registers a builtin handler
 *    (registerBuiltin, the policy table's putPolicyTable). One that does
 *    is a tool path of server/web: its imports must be checked here too
 *    before it lands.
 *
 * A hook server/web hands a package at boot and a tool later calls is not
 * an import, so this cannot see it; none reads the session today.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB = join(ROOT, 'server/web');

const SOURCE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
const TEST = /\.test\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;

/** Every source file under `dir`, tests and node_modules aside. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (SOURCE.test(name) && !TEST.test(name)) out.push(path);
  }
  return out;
}

/** Comments out, so a doc comment that names a module is no import. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** The module specifiers a file imports, re-exports or loads. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  const re =
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bvi\.mock\(\s*['"]([^'"]+)['"]/g;
  for (const m of code(text).matchAll(re)) {
    const s = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (s) out.push(s);
  }
  return out;
}

/** Why `spec`, imported by `file`, reaches the session or server/web, or null. */
function reachesWeb(file: string, spec: string): string | null {
  if (/^@\/lib\/auth(?:\/|$)/.test(spec)) return 'the session readers (@/lib/auth)';
  if (/(^|\/)server\/web(\/|$)/.test(spec)) return 'a module of server/web';
  if (spec.startsWith('.')) {
    const target = resolve(dirname(file), spec);
    if (target === WEB || target.startsWith(`${WEB}/`)) return 'a module of server/web';
  }
  return null;
}

describe('no tool path reads the HTTP session (A5 step 3b fix round 1, LOW-4)', () => {
  const packageFiles = sources(join(ROOT, 'packages'));

  it('scans the tool packages (not vacuous)', () => {
    const rel = packageFiles.map((f) => relative(ROOT, f));
    expect(rel).toContain('packages/tools/src/dispatch.ts');
    expect(rel.some((f) => f.startsWith('packages/runtime/src/'))).toBe(true);
    expect(rel.some((f) => f.startsWith('packages/content/src/'))).toBe(true);
    // The detector sees what it must refuse.
    expect(reachesWeb(join(ROOT, 'packages/tools/src/x.ts'), '@/lib/auth')).not.toBeNull();
    expect(reachesWeb(join(ROOT, 'packages/tools/src/x.ts'), '@/lib/auth/session')).not.toBeNull();
    expect(
      reachesWeb(join(ROOT, 'packages/tools/src/x.ts'), '../../../server/web/lib/auth'),
    ).not.toBeNull();
    expect(specifiers("const s = await import('@/lib/auth');")).toEqual(['@/lib/auth']);
    expect(specifiers("// import { ownerCaller } from '@/lib/auth';")).toEqual([]);
  });

  it('no package source imports the session readers or any module of server/web', () => {
    const found: string[] = [];
    for (const file of packageFiles) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const why = reachesWeb(file, spec);
        if (why) found.push(`${relative(ROOT, file)}: '${spec}' (${why})`);
      }
    }
    expect(found).toEqual([]);
  });

  it('no server/web module registers a builtin handler (a tool path there)', () => {
    const registers = /\b(?:registerBuiltin|putPolicyTable)\s*\(/;
    const found = sources(WEB)
      .filter((f) => registers.test(code(readFileSync(f, 'utf8'))))
      .map((f) => relative(ROOT, f));
    expect(found, 'check its imports for @/lib/auth here before it lands').toEqual([]);
  });
});
