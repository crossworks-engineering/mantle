/**
 * Every dispatch entry names its caller (workspaces arch A5 steps 3a and
 * 3b): a static sweep of the product code for each call of dispatchTool and
 * of dispatchViaBridge (under any local name), which must pass a `caller` in
 * its context, so the call runs through the one gate (enterCall). Since A5
 * step 3b no entry names none (the app tool brokers and the dev console
 * moved): a call that names no caller is refused (NO_TOOL_CALLER_ERROR), and
 * the list of entries that may stays empty.
 *
 * A builtin's handler called directly (`def.handler(...)`, or the function
 * getBuiltinHandler gives) skips dispatch and so the gate. The second sweep
 * finds each such call in the product code: dispatch's own, a definition's
 * wrapper that runs inside the dispatch of its own call, and the entries
 * that bypass dispatch until a later step (listed, and the list only
 * shrinks). A new direct call fails here (A5 step 3a low round, LOW-3).
 *
 * A SOURCE check, as gate-boot.test.ts's entry half is.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The entries that name no caller yet (none since A5 step 3b: the app
 *  tool brokers and the dev console were the last). */
const NO_CALLER_YET: Readonly<Record<string, string>> = {};

/** The entries A5 step 3b moved onto the gate: each names its caller now. */
const MOVED_IN_STEP_3B: readonly string[] = [
  'server/web/lib/app-runner.ts',
  'server/web/app/api/apps/[id]/tool-broker/route.ts',
  'server/web/app/s/[token]/tool-broker/route.ts',
  'server/web/app/api/dev-tools/execute-tool/route.ts',
];

/** The direct handler calls that are no entry: dispatch itself, and a
 *  definition's wrapper that calls the definition it wraps. */
const DIRECT_HANDLER_OK: Readonly<Record<string, string>> = {
  'packages/tools/src/dispatch.ts': 'dispatch itself: the handler it gates (getBuiltinHandler)',
  'packages/tools/src/builtins-apps.ts':
    "withAuthorCeiling: the app tools' wrapper, inside the dispatch of its own call",
};

/** The entries that call a builtin's handler directly, past dispatch and
 *  the gate, and the step that moves each. */
const DIRECT_HANDLER_YET: Readonly<Record<string, string>> = {};

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

/** Comments out, so a mention in prose is no call. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** A builtin handler called directly: `.handler(` (and `?.handler(`,
 *  `['handler'](`), and any use of getBuiltinHandler but its definition. */
const DIRECT_HANDLER = new RegExp(
  [
    String.raw`\??\.handler\s*\(`,
    String.raw`\[\s*['"]handler['"]\s*\]\s*\(`,
    String.raw`(?<!function\s+)\bgetBuiltinHandler\b(?!\s*,|\s*\})`,
  ].join('|'),
  'g',
);

/** Every file with a direct handler call, and how many. */
function directSweep(): Map<string, number> {
  const out = new Map<string, number>();
  for (const root of ['packages', 'server']) {
    for (const path of sourceFiles(join(repoRoot, root))) {
      const file = relative(repoRoot, path);
      const hits = code(readFileSync(path, 'utf8')).match(DIRECT_HANDLER)?.length ?? 0;
      if (hits > 0) out.set(file, hits);
    }
  }
  return out;
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
      // A5 step 4: the owner MCP surface and the /api/v1 builtin routes.
      'packages/mcp-core/src/gated-tools.ts',
      'server/web/lib/api-v1-builtin.ts',
      // A5 step 3b: the app tool brokers and the dev console.
      ...MOVED_IN_STEP_3B,
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

  it('no entry names no caller any more (A5 step 3b)', () => {
    expect(Object.keys(NO_CALLER_YET)).toEqual([]);
    for (const file of MOVED_IN_STEP_3B) {
      const here = sites.filter((s) => s.file === file);
      expect(here.length, file).toBeGreaterThan(0);
      expect(
        here.every((s) => s.caller),
        file,
      ).toBe(true);
    }
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

  describe('no entry calls a builtin handler past dispatch (low round, LOW-3)', () => {
    const direct = directSweep();

    it('finds the direct calls (not vacuous)', () => {
      for (const file of [...Object.keys(DIRECT_HANDLER_OK), ...Object.keys(DIRECT_HANDLER_YET)]) {
        expect(direct.has(file), file).toBe(true);
      }
    });

    it('calls a handler directly only where listed', () => {
      const unlisted = [...direct.keys()].filter(
        (f) => !(f in DIRECT_HANDLER_OK) && !(f in DIRECT_HANDLER_YET),
      );
      expect(unlisted, 'a direct handler call skips the gate: dispatch it').toEqual([]);
    });

    it('no entry calls a builtin handler directly any more (A5 step 4)', () => {
      expect(Object.keys(DIRECT_HANDLER_YET)).toEqual([]);
    });

    it('the not-yet-gated direct entries are no dispatch entries too', () => {
      for (const file of Object.keys(DIRECT_HANDLER_YET)) {
        expect(file in NO_CALLER_YET, file).toBe(false);
      }
    });
  });
});
