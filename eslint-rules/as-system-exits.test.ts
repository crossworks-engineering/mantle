/**
 * The exits engine (as-system-exits.mjs) against the ways an exit could
 * hide, and the split of the exits by route (as-system-routes.mjs). The
 * counts on the repo are pinned by `pnpm arch:check`.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS module, no types shipped.
import { asSystemExits } from './as-system-exits.mjs';
import {
  AS_SYSTEM_ROUTE_SEED,
  asSystemReasons,
  asSystemRouteCounts,
  asSystemRouteMap,
  // @ts-expect-error: plain-JS module, no types shipped.
} from './as-system-routes.mjs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

type Exits = {
  byReason: Record<string, number>;
  byFile: Record<string, number>;
  holders: { name: string | null; reasons: string[]; exits: number }[];
  problems: string[];
};

const run = (call: string, ...texts: string[]) =>
  asSystemExits(
    texts.map((text, i) => ({ path: `f${i}.ts`, text })),
    call === 'asSystem' ? {} : { call, follow: 'forwarders' },
  ) as Exits;

const head = "import { asSystem } from '@mantle/db';\n";

describe('a use of the call that is not a call is a problem', () => {
  const uses = [
    ['a callback', 'list.map(asSystem);'],
    ['.call', "asSystem.call(null, f, 'x');"],
    ['.apply', "asSystem.apply(null, [f, 'x']);"],
    ['.bind', 'const g = asSystem.bind(null);'],
    ['Reflect.apply', "Reflect.apply(asSystem, null, [f, 'x']);"],
    ['a ternary', "const g = on ? asSystem : other; g(f, 'x');"],
    ['??', "const g = maybe ?? asSystem; g(f, 'x');"],
    ['a list', "const gs = [asSystem]; gs[0](f, 'x');"],
    ['a default parameter', "function run(go = asSystem) { return go(f, 'x'); }"],
    ['id()', "id(asSystem)(f, 'x');"],
    ['a comma call', "(0, asSystem)(f, 'x');"],
    ['a shorthand property', 'const api = { asSystem };'],
    ['a default export', 'export default asSystem;'],
    ['an assignment', 'db.asSystem = wrap;'],
    ['a member, as a value', "const g = db.asSystem; g(f, 'x');"],
    ['a subscript, as a value', "const g = db['asSystem'];"],
  ];
  for (const [what, line] of uses) {
    it(what, () => {
      const r = run('asSystem', head + line);
      expect(r.problems.length, line).toBeGreaterThan(0);
      expect(r.problems.join('\n')).toMatch(/asSystem/);
    });
  }

  it('the same for noteRequestSystem', () => {
    const r = run(
      'noteRequestSystem',
      "import { noteRequestSystem } from '@mantle/db';\nhooks.push(noteRequestSystem);",
    );
    expect(r.problems.join('\n')).toMatch(/uses noteRequestSystem as a value/);
  });

  it('leaves out imports, exports, type queries and its own declaration', () => {
    const own =
      'export function asSystem<T>(fn: () => Promise<T>, reason: string): Promise<T> { return fn(); }';
    expect(run('asSystem', own).problems).toEqual([]);
    // A re-export under another name still is one (its importers call it
    // by that name).
    expect(run('asSystem', "export { asSystem as sys } from '@mantle/db';").problems).toEqual([
      'f0.ts renames asSystem (as sys): call it by its name',
    ]);
    const fine = run(
      'asSystem',
      [
        head,
        "export { asSystem } from '@mantle/db';",
        'type A = typeof asSystem;',
        'type R = Parameters<typeof asSystem>[1];',
        "function f(): Promise<void> { return asSystem(async () => {}, 'audit-log'); }",
        "const g = () => db.asSystem(async () => {}, 'audit-log');",
        "const h = () => db?.['asSystem'](async () => {}, 'audit-log');",
        "const k = () => asSystem<number>(async () => 1, 'audit-log');",
        'interface I { asSystem: (f: () => void) => void }',
      ].join('\n'),
    );
    expect(fine.problems).toEqual([]);
  });
});

describe('holders that would hide their uses', () => {
  it('a default-exported holder is a problem, named or anonymous', () => {
    const named = run(
      'asSystem',
      head + "export default function f() { return asSystem(g, 'x'); }",
    );
    expect(named.problems.join('\n')).toMatch(/default export/);
    const anon = run('asSystem', head + "export default async () => asSystem(g, 'x');");
    expect(anon.problems.join('\n')).toMatch(/default export/);
    const later = run('asSystem', head + "const f = () => asSystem(g, 'x');\nexport default f;");
    expect(later.problems.join('\n')).toMatch(/default export/);
  });

  it('a class field arrow is a member holder, followed into other files', () => {
    const r = run(
      'asSystem',
      head + "export class Store { save = async () => asSystem(g, 'audit-log'); }",
      "import { Store } from './f0';\nconst s = new Store();\nawait s.save();\nawait s.save();",
    );
    expect(r.problems).toEqual([]);
    expect(r.byFile['f1.ts']).toBe(2);
    expect(r.byReason['audit-log']).toBe(2);
  });

  it('a method is followed into other files, as an object can be handed anywhere', () => {
    const r = run(
      'asSystem',
      head + "export const api = { save() { return asSystem(g, 'audit-log'); } };",
      "import { api } from './f0';\nawait api.save();",
      'function other(x) { return x.save(); }',
    );
    expect(r.byFile['f1.ts']).toBe(1);
    expect(r.byFile['f2.ts']).toBe(1);
  });

  it('a method taken off its object in another file is a problem', () => {
    const r = run(
      'asSystem',
      head + "export const api = { save() { return asSystem(g, 'audit-log'); } };",
      "import { api } from './f0';\nconst s = api.save;\nawait s();",
    );
    expect(r.problems.join('\n')).toMatch(/renames the asSystem holder save/);
  });

  it('counts each holder with its reasons', () => {
    const r = run(
      'asSystem',
      head +
        "function a() { return on ? asSystem(g, 'admin-area') : asSystem(g, 'heartbeat-own-row'); }\na(); a();",
    );
    expect(r.holders.map((h) => [h.name, h.reasons, h.exits])).toEqual([
      ['a', ['admin-area', 'heartbeat-own-row'], 2],
    ]);
  });
});

describe('the exits by route', () => {
  const holders = [
    { reasons: ['app-data'], exits: 3 },
    { reasons: ['admin-area'], exits: 2 },
    { reasons: ['admin-area', 'heartbeat-own-row'], exits: 4 },
    { reasons: [], exits: 1 },
    { reasons: ['audit-log'], exits: 0 },
  ];
  const reasons = ['app-data', 'admin-area', 'heartbeat-own-row', 'audit-log'];

  it('every exit is full on the seed', () => {
    const all = Object.fromEntries(reasons.map((r) => [r, 'full']));
    const r = asSystemRouteCounts(holders, { routes: all, reasons }) as {
      full: number;
      narrow: number;
      byReason: Record<string, { route: string; exits: number }>;
      problems: string[];
    };
    expect([r.full, r.narrow, r.problems]).toEqual([10, 0, []]);
    expect(r.byReason['admin-area+heartbeat-own-row']).toEqual({ route: 'full', exits: 4 });
    expect(r.byReason.unnamed).toEqual({ route: 'full', exits: 1 });
  });

  it('a holder runs narrow only when each of its reasons does; an unread one stays full', () => {
    const routes = {
      'app-data': 'full',
      'admin-area': 'narrow',
      'heartbeat-own-row': 'full',
      'audit-log': 'narrow',
    };
    const r = asSystemRouteCounts(holders, { routes, reasons }) as { full: number; narrow: number };
    expect([r.full, r.narrow]).toEqual([8, 2]);
    const both = { ...routes, 'heartbeat-own-row': 'narrow' };
    const r2 = asSystemRouteCounts(holders, { routes: both, reasons }) as {
      full: number;
      narrow: number;
    };
    expect([r2.full, r2.narrow]).toEqual([4, 6]);
  });

  it('a reason with no route, a bad route and a stray entry are problems', () => {
    const r = asSystemRouteCounts([], {
      routes: { 'app-data': 'full', 'admin-area': 'half', gone: 'full' },
      reasons: ['app-data', 'admin-area', 'audit-log'],
    }) as { problems: string[] };
    expect(r.problems).toEqual([
      "asSystem reason audit-log has no route: pick 'narrow' or 'full'",
      "asSystem reason admin-area routes 'half': 'narrow' or 'full'",
      'the route map names gone, which is no asSystem reason',
    ]);
  });

  it('the repo: the seed routes every reason AsSystemReason admits, all full', () => {
    const reasonsNow = asSystemReasons(ROOT) as string[];
    expect(reasonsNow.length).toBeGreaterThan(10);
    expect(Object.keys(AS_SYSTEM_ROUTE_SEED).sort()).toEqual([...reasonsNow].sort());
    expect(new Set(Object.values(AS_SYSTEM_ROUTE_SEED))).toEqual(new Set(['full']));
    const map = asSystemRouteMap(ROOT) as { source: string; routes: Record<string, string> };
    expect(map.source).toBe('seed');
  });
});
