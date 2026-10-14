/**
 * Every dispatch entry names its caller (workspaces arch A5 step 3a): a
 * static sweep of the product code for each call of dispatchTool and of
 * dispatchViaBridge (under any local name), which must pass a `caller` in
 * its context, so the call runs through the one gate (enterCall). A call
 * that names none runs dispatch's own checks, as before step 3a: only the
 * entries listed below, each with the step that moves it, and the list
 * only shrinks.
 *
 * A SOURCE check, as gate-boot.test.ts's entry half is.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The entries that name no caller yet, and the step that moves each. */
const NO_CALLER_YET: Readonly<Record<string, string>> = {
  'server/web/lib/app-runner.ts': 'A5 step 3b: the app host call broker',
  'server/web/app/api/apps/[id]/tool-broker/route.ts': 'A5 step 3b: the app tool broker',
  'server/web/app/s/[token]/tool-broker/route.ts': 'A5 step 3b: the shared app tool broker',
  'server/web/app/api/dev-tools/execute-tool/route.ts': 'A5 step 3b: the dev console',
  'packages/mcp-core/src/login-surface.ts': "A5 step 4: the owner MCP surface's connector rows",
};

/** Product source files (no tests, no build output). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** The local names a file calls dispatch by: its own, and an alias of
 *  either import (`dispatchViaBridge as dispatchTool`). */
function dispatchNames(text: string): string[] {
  const names = new Set<string>();
  if (/\bdispatchTool\b/.test(text)) names.add('dispatchTool');
  if (/\bdispatchViaBridge\b/.test(text)) names.add('dispatchViaBridge');
  for (const m of text.matchAll(/\b(?:dispatchTool|dispatchViaBridge)\s+as\s+(\w+)/g)) {
    names.add(m[1]!);
  }
  return [...names];
}

/** The argument text of each call of `name` in `text` (not its
 *  definition, not an import): from its `(` to the matching `)`. */
function callArgs(text: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<!function\\s+)(?<![\\w.])${name}\\s*\\(`, 'g');
  for (const m of text.matchAll(re)) {
    let depth = 0;
    let end = m.index! + m[0].length - 1;
    for (; end < text.length; end += 1) {
      const c = text[end];
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(text.slice(m.index! + m[0].length, end));
  }
  return out;
}

/** Every call site, with whether it passes a caller. */
function sweep(): { file: string; args: string; caller: boolean }[] {
  const sites: { file: string; args: string; caller: boolean }[] = [];
  for (const root of ['packages', 'server']) {
    for (const path of sourceFiles(join(repoRoot, root))) {
      const text = readFileSync(path, 'utf8');
      const file = relative(repoRoot, path);
      // The definitions: dispatch.ts's own recipe step is a call and is swept.
      if (file === 'packages/tools/src/dispatch-bridge.ts') continue;
      for (const name of dispatchNames(text)) {
        for (const args of callArgs(text, name)) {
          // A `caller` property (`caller: x`, or shorthand), comments aside.
          const code = args.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
          sites.push({ file, args, caller: /(?:^|[{,])\s*caller\s*(?=[:,}]|$)/m.test(code) });
        }
      }
    }
  }
  return sites;
}

describe('every dispatch entry names its caller (A5 step 3a)', () => {
  const sites = sweep();

  it('finds the entries (not vacuous)', () => {
    const files = new Set(sites.map((s) => s.file));
    for (const file of [
      'packages/runtime/src/agent/tool-loop/execute-call.ts',
      'packages/tools/src/pending.ts',
      'server/web/lib/runs/execute-item.ts',
      'packages/tools/src/dispatch.ts',
      'packages/tools/src/toolsmith/recipes.ts',
      'packages/tools/src/toolsmith/api-tools.ts',
      ...Object.keys(NO_CALLER_YET),
    ]) {
      expect(files.has(file), file).toBe(true);
    }
  });

  it('passes a caller at every site but the listed ones', () => {
    const missing = sites
      .filter((s) => !s.caller && !(s.file in NO_CALLER_YET))
      .map((s) => `${s.file}: ${s.args.replace(/\s+/g, ' ').slice(0, 80)}`);
    expect(missing).toEqual([]);
  });

  it('lists only entries that still name none (the list only shrinks)', () => {
    for (const file of Object.keys(NO_CALLER_YET)) {
      const here = sites.filter((s) => s.file === file);
      expect(here.length, file).toBeGreaterThan(0);
      expect(
        here.some((s) => !s.caller),
        `${file} names its caller now: take it off NO_CALLER_YET`,
      ).toBe(true);
    }
  });
});
