import { join } from 'node:path';
import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import {
  asSystemSites,
  builtinSlugs,
  countedFiles,
  guardCalls,
  isCounted,
  isRouteFile,
  keptNotes,
  listLiterals,
  readPathWrites,
  measure,
  rawAclLines,
  readRepoFile,
  routePolicyLists,
  stripComments,
  toolPolicyLists,
  // @ts-expect-error: plain-JS module, no types shipped.
} from './arch-counts.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { RAW_ACL_PINS, rule as rawAclRule } from './no-raw-acl-columns.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { AS_SYSTEM_PINS, rule as asSystemRule } from './as-system-allowlist.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { ROUTE_LIST_PINS, TOOL_LIST_PINS } from './no-policy-name-lists.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { STORE_PINS } from './store-brokers.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { GUARD_CALL_PIN } from './no-guard-calls.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { ACTOR_SETTER_PATTERN, rule as actorSettersRule } from './actor-setters.mjs';
import { AS_SYSTEM_OTHER_REASONS, AS_SYSTEM_TURN_REASONS } from '../packages/db/src/viewer';

/** Every reason asSystem takes (arch A2a). */
const KNOWN_AS_SYSTEM_REASONS: readonly string[] = [
  ...AS_SYSTEM_TURN_REASONS,
  ...AS_SYSTEM_OTHER_REASONS,
];

/**
 * The architecture ratchets (workspaces arch plan v2, section 11; A0), in
 * pinned-count mode: each lint lists what the repo holds today, file by
 * file, and fails on any other count. A count that went down needs its pin
 * lowered in the same change; one that went up needs review (say why in the
 * PR). The same counts feed scripts/arch-scoreboard.ts.
 */
const ROOT = join(__dirname, '..');
const got = measure(ROOT) as {
  numbers: Record<string, number>;
  perFile: {
    asSystem: Record<string, { count: number; reasons: string[] }>;
    rawAcl: Record<string, number>;
    toolLists: Record<string, { lists: number; entries: number }>;
    routeLists: Record<string, number>;
    stores: Record<string, string[]>;
  };
};

/** The differences between a pinned map and a found one, as lines. */
function diff<T>(pins: Record<string, T>, found: Record<string, T>, show = String): string[] {
  const out: string[] = [];
  for (const f of new Set([...Object.keys(pins), ...Object.keys(found)])) {
    const a = pins[f] === undefined ? 'none' : show(pins[f] as T);
    const b = found[f] === undefined ? 'none' : show(found[f] as T);
    if (a !== b) out.push(`${f}: pinned ${a}, found ${b}`);
  }
  return out.sort();
}

describe('the architecture ratchets (pinned counts)', () => {
  it('no-raw-acl-columns: raw ACL reads outside packages/db, file by file', () => {
    expect(diff(RAW_ACL_PINS, got.perFile.rawAcl)).toEqual([]);
  });

  it('as-system-allowlist: asSystem call sites and their reasons, file by file', () => {
    const counts = Object.fromEntries(
      Object.entries(got.perFile.asSystem).map(([f, v]) => [f, v.count]),
    );
    const pinned = Object.fromEntries(
      Object.entries(AS_SYSTEM_PINS as Record<string, { count: number }>).map(([f, v]) => [
        f,
        v.count,
      ]),
    );
    expect(diff(pinned, counts)).toEqual([]);
    for (const [f, pin] of Object.entries(
      AS_SYSTEM_PINS as Record<string, { count: number; why: string[] }>,
    )) {
      const reasons = got.perFile.asSystem[f]?.reasons ?? [];
      // Each site names a real reason (arch A2a); 'test' never in product code.
      expect(pin.why, f).toEqual(reasons);
      expect(reasons.length, f).toBeGreaterThan(0);
      for (const r of reasons) {
        expect(KNOWN_AS_SYSTEM_REASONS, `${f}: ${r}`).toContain(r);
        expect(r, f).not.toBe('test');
      }
    }
  });

  it('actor-setters-in-db-only: no counted file outside packages/db names the actor settings', () => {
    const outside = countedFiles(ROOT).filter((f: string) => {
      if (f.startsWith('packages/db/src/')) return false;
      const text = readRepoFile(ROOT, f);
      return text !== null && ACTOR_SETTER_PATTERN.test(stripComments(text));
    });
    expect(outside).toEqual([]);
  });

  it('no-policy-name-lists: tool and route policy lists, file by file', () => {
    const show = (v: unknown) => JSON.stringify(v);
    expect(diff(TOOL_LIST_PINS, got.perFile.toolLists, show)).toEqual([]);
    expect(diff(ROUTE_LIST_PINS, got.perFile.routeLists)).toEqual([]);
  });

  it('store-brokers: the files that reach each disk store, store by store', () => {
    const show = (v: unknown) => JSON.stringify(v);
    expect(diff(STORE_PINS, got.perFile.stores, show)).toEqual([]);
  });

  it('no-guard-calls (count only until A4): the guard calls in route files', () => {
    // A new route is guarded until A4 (M-2): the count may grow, never drop.
    expect(got.numbers.guardCalls).toBeGreaterThanOrEqual(GUARD_CALL_PIN);
  });
});

describe('the counters', () => {
  it('blank comments and keep strings', () => {
    const t = 'a // x read_ws\n/* home_ws\n write_ws */ b \'http://x\' "//y"';
    const s = stripComments(t);
    expect(s.split('\n')).toHaveLength(3);
    expect(s).not.toMatch(/read_ws|home_ws|write_ws/);
    expect(s).toContain("'http://x'");
    expect(s).toContain('"//y"');
    expect(rawAclLines('// read_ws\nconst a = n.read_ws;\n/**\n * homeWs\n */')).toBe(1);
  });

  it('count asSystem calls with their reasons, not the definition or imports', () => {
    const src = [
      "import { asSystem } from '@mantle/db';",
      'export async function asSystem(fn, why) {}',
      "await asSystem(() => db.select(), 'kind-root');",
      "await asSystem(\n  async () => {\n    f('x');\n  },\n  'name-taken',\n);",
      '// asSystem(() => 1, "nope")',
    ].join('\n');
    expect(asSystemSites(src)).toEqual({ count: 2, reasons: ['kind-root', 'name-taken'] });
  });

  it('find list literals, a nested list belonging to the outer one', () => {
    const src =
      "const A: ReadonlySet<string> = new Set(['a', 'b']);\nconst B = [['x', 1], ['y', 2]];\nf(['no']);";
    expect(listLiterals(src)).toEqual(["['a', 'b']", "[['x', 1], ['y', 2]]"]);
    const slugs = new Set(['note_create', 'page_create', 'task_create']);
    expect(
      toolPolicyLists(
        "const S = new Set(['note_create', 'page_create', 'task_create', 'x']);",
        slugs,
      ),
    ).toEqual([3]);
    expect(routePolicyLists("const R = ['GET /api/a', 'POST /api/b', '/api/c'];")).toEqual([3]);
    expect(routePolicyLists("const R = ['GET /api/a', 'x'];")).toEqual([]);
  });

  it('count guard calls and know a route file', () => {
    expect(
      guardCalls('const u = await getOwnerOr401();\n// getMemberOr401()\ngetLoginOr401();'),
    ).toBe(2);
    expect(isRouteFile('server/web/app/api/pages/route.ts')).toBe(true);
    expect(isRouteFile('server/web/lib/pages.ts')).toBe(false);
  });

  it('count product code only', () => {
    expect(isCounted('packages/content/src/x.ts')).toBe(true);
    expect(isCounted('packages/content/src/x.test.ts')).toBe(false);
    expect(isCounted('packages/db/migrations/0001_x.sql')).toBe(false);
    expect(isCounted('server/web/server/route-manifest.gen.ts')).toBe(false);
    expect(isCounted('scripts/arch-scoreboard.ts')).toBe(false);
    expect(countedFiles(ROOT).length).toBeGreaterThan(500);
    expect(readRepoFile(ROOT, 'no/such/file.ts')).toBeNull();
    expect(builtinSlugs(ROOT).has('note_create')).toBe(true);
  });
});

describe('the scoreboard pins', () => {
  it('a re-pin keeps a note while its pin holds and drops it once it came down', () => {
    const notes = { a: 'raised 1 to 2', b: 'raised 3 to 4', gone: 'no number' };
    expect(keptNotes(notes, { a: 2, b: 4 }, { a: 2, b: 3 })).toEqual({
      a: 'raised 1 to 2',
      gone: 'no number',
    });
    expect(keptNotes(undefined, {}, {})).toEqual({});
  });

  it('counts the named writes inside read paths', () => {
    const names = readPathWrites(ROOT) as string[];
    expect(names.length).toBe(got.numbers.readPathWrites);
    for (const n of names) expect(n).toMatch(/^(repair|backfill):[a-z0-9-]+$/);
  });
});

describe('the editor rules', () => {
  const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });
  it('flag a raw ACL read in an unpinned file, and none in packages/db or a comment', () => {
    tester.run('no-raw-acl-columns', rawAclRule, {
      valid: [
        { code: 'const a = n.read_ws;', filename: '/r/packages/db/src/x.ts' },
        { code: '// read_ws\nconst b = 1;', filename: '/r/packages/search/src/new.ts' },
        { code: 'const a = n.read_ws;', filename: '/r/packages/search/src/new.test.ts' },
      ],
      invalid: [
        {
          code: 'const a = n.read_ws;',
          filename: '/r/packages/search/src/new.ts',
          errors: [{ messageId: 'over' }],
        },
      ],
    });
  });

  it('flag asSystem in an unpinned file, and allow a pinned file up to its pin', () => {
    const [pinned, pin] = Object.entries(AS_SYSTEM_PINS as Record<string, { count: number }>)[0]!;
    const calls = (n: number) =>
      Array.from({ length: n }, () => "asSystem(() => 1, 'x');").join('\n');
    tester.run('as-system-allowlist', asSystemRule, {
      valid: [{ code: calls(pin.count), filename: `/r/${pinned}` }],
      invalid: [
        {
          code: calls(1),
          filename: '/r/packages/search/src/new.ts',
          errors: [{ messageId: 'over' }],
        },
        {
          code: calls(pin.count + 1),
          filename: `/r/${pinned}`,
          errors: [{ messageId: 'over' }],
        },
      ],
    });
  });

  it('flag the actor settings outside packages/db, and none there, in a test or a comment', () => {
    tester.run('actor-setters-in-db-only', actorSettersRule, {
      valid: [
        { code: "q('select mantle_set_actor($1, $2)');", filename: '/r/packages/db/src/client.ts' },
        { code: "q(`set_config('mantle.actor', x)`);", filename: '/r/server/web/x.test.ts' },
        { code: '// mantle.write_mode\nconst b = 1;', filename: '/r/packages/search/src/new.ts' },
      ],
      invalid: [
        {
          code: "q(`select set_config('mantle.actor', ${a}, true)`);",
          filename: '/r/packages/search/src/new.ts',
          errors: [{ messageId: 'notHere' }],
        },
        {
          code: "q('select mantle_operator_actor($1)');",
          filename: '/r/server/web/lib/x.ts',
          errors: [{ messageId: 'notHere' }],
        },
      ],
    });
  });
});
