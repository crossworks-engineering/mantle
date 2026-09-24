import { describe, expect, it } from 'vitest';
import type { AppNavEntry } from '@mantle/client-types/app-nav';
import {
  appNavAppIds,
  appNavIssue,
  canMoveAppNavEntry,
  dissolveAppNavFolder,
  flattenAppNav,
  moveAppNavEntry,
  placeAppNavApp,
  projectAppIcon,
  projectAppNav,
  pruneAppNav,
  updateAppNavFolder,
} from './app-nav';

// Readable UUIDs: the tree only ever stores UUIDs.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const app = (n: number): AppNavEntry => ({ kind: 'app', id: id(n) });
const folder = (n: number, children: AppNavEntry[], name = `F${n}`): AppNavEntry => ({
  kind: 'folder',
  id: id(n),
  name,
  children,
});

// F100 › F101 › F102 (three levels, the maximum), plus a root app.
const deep = (): AppNavEntry[] => [
  folder(100, [folder(101, [folder(102, [app(1)]), app(2)]), app(3)]),
  app(4),
];

describe('projectAppIcon', () => {
  it('accepts emoji and well-formed lucide names', () => {
    expect(projectAppIcon('🌤️')).toBe('🌤️');
    expect(projectAppIcon('lucide:chart-bar')).toBe('lucide:chart-bar');
  });
  it('rejects text posing as an emoji and malformed lucide names', () => {
    expect(projectAppIcon('chart-bar')).toBeUndefined();
    expect(projectAppIcon('lucide:Chart Bar')).toBeUndefined();
    expect(projectAppIcon('lucide:')).toBeUndefined();
    expect(projectAppIcon('')).toBeUndefined();
    expect(projectAppIcon(42)).toBeUndefined();
  });
});

describe('appNavIssue (strict write check)', () => {
  it('accepts a tree three folders deep', () => {
    expect(appNavIssue(deep())).toBeNull();
  });
  it('rejects a fourth folder level', () => {
    const tooDeep = [folder(100, [folder(101, [folder(102, [folder(103, [])])])])];
    expect(appNavIssue(tooDeep)).toMatch(/3 levels/);
  });
  it('rejects duplicates, bad ids, unnamed folders and unknown colours', () => {
    expect(appNavIssue([app(1), folder(100, [app(1)])])).toMatch(/more than once/);
    expect(appNavIssue([{ kind: 'app', id: 'nope' }])).toMatch(/UUID/);
    expect(appNavIssue([folder(100, [], '   ')])).toMatch(/needs a name/);
    expect(appNavIssue([{ ...folder(100, []), color: 'chartreuse' }])).toMatch(/colour/);
    expect(appNavIssue('x')).toMatch(/array/);
  });
});

describe('projectAppNav (tolerant read)', () => {
  it('round-trips a valid layout', () => {
    expect(projectAppNav({ rev: 7, entries: deep() })).toEqual({ rev: 7, entries: deep() });
  });
  it('dissolves a too-deep folder, lifting its apps rather than losing them', () => {
    const stored = {
      rev: 1,
      entries: [folder(100, [folder(101, [folder(102, [folder(103, [app(9)])])])])],
    };
    const nav = projectAppNav(stored)!;
    expect(appNavAppIds(nav.entries)).toEqual([id(9)]);
    expect(nav.entries).toEqual([folder(100, [folder(101, [folder(102, [app(9)])])])]);
  });
  it('keeps the first of a repeated id and drops junk', () => {
    const nav = projectAppNav({ entries: [app(1), app(1), null, { kind: 'x', id: id(2) }] })!;
    expect(nav).toEqual({ rev: 0, entries: [app(1)] });
  });
  it('is undefined for garbage', () => {
    expect(projectAppNav(null)).toBeUndefined();
    expect(projectAppNav({ entries: 'no' })).toBeUndefined();
  });
});

describe('pruneAppNav', () => {
  it('drops deleted apps but keeps the folders that held them', () => {
    const out = pruneAppNav(deep(), (appId) => appId !== id(1));
    expect(appNavAppIds(out)).toEqual([id(2), id(3), id(4)]);
    expect(out[0]).toEqual(folder(100, [folder(101, [folder(102, []), app(2)]), app(3)]));
  });
});

describe('moving entries', () => {
  it('reorders within the root', () => {
    const out = moveAppNavEntry([app(1), app(2), app(3)], id(3), null, 0);
    expect(out).toEqual([app(3), app(1), app(2)]);
  });
  it('moves an app into a folder at an index', () => {
    const out = moveAppNavEntry([folder(100, [app(1)]), app(2)], id(2), id(100), 0)!;
    expect(out).toEqual([folder(100, [app(2), app(1)])]);
  });
  it('refuses a folder into itself or its own descendant', () => {
    expect(canMoveAppNavEntry(deep(), id(100), id(100))).toBe(false);
    expect(canMoveAppNavEntry(deep(), id(100), id(102))).toBe(false);
  });
  it('refuses a move that would exceed three levels', () => {
    // F101 is two folder levels tall (F101 › F102). F201 already sits one
    // level down, so F101 inside it would make four.
    const tree = [folder(100, [folder(101, [folder(102, [])])]), folder(200, [folder(201, [])])];
    expect(canMoveAppNavEntry(tree, id(101), id(201))).toBe(false);
    expect(moveAppNavEntry(tree, id(101), id(201), 0)).toBeNull();
    // ...but a flat folder fits there.
    expect(canMoveAppNavEntry(tree, id(102), id(201))).toBe(true);
  });
  it('never mutates its input', () => {
    const tree = deep();
    const snapshot = JSON.stringify(tree);
    moveAppNavEntry(tree, id(4), id(102), 0);
    expect(JSON.stringify(tree)).toBe(snapshot);
  });
});

describe('placing, dissolving and editing folders', () => {
  it('places an unsorted app once, and only into a real folder', () => {
    expect(placeAppNavApp([folder(100, [])], id(5), id(100), 0)).toEqual([folder(100, [app(5)])]);
    expect(placeAppNavApp([app(5)], id(5), null, 0)).toBeNull();
    expect(placeAppNavApp([], id(5), id(999), 0)).toBeNull();
  });
  it('dissolves a folder into its parent, keeping order', () => {
    const out = dissolveAppNavFolder([app(1), folder(100, [app(2), app(3)]), app(4)], id(100));
    expect(out).toEqual([app(1), app(2), app(3), app(4)]);
  });
  it('renames and recolours, clearing with null', () => {
    const tree = [{ ...folder(100, []), color: 'teal' as const }];
    const out = updateAppNavFolder(tree, id(100), { name: '  Risk  ', color: null })!;
    expect(out[0]).toEqual(folder(100, [], 'Risk'));
  });
});

describe('flattenAppNav', () => {
  it('descends only into open folders and marks last children', () => {
    const rows = flattenAppNav(deep(), (f) => f !== id(101));
    expect(rows.map((r) => [r.entry.id, r.depth, r.isLast])).toEqual([
      [id(100), 0, false],
      [id(101), 1, false],
      [id(3), 1, true],
      [id(4), 0, true],
    ]);
  });
  it('carries whether each ancestor was last, for the guide lines', () => {
    const rows = flattenAppNav(deep(), () => true);
    const app1 = rows.find((r) => r.entry.id === id(1))!;
    // Ancestors: F100 (not last at root), F101 (not last in F100), F102 (not last in F101).
    expect(app1.guides).toEqual([false, false, false]);
    expect(app1.depth).toBe(3);
  });
});
