/**
 * The split rule on its own: items are lines named by id, a line hangs off
 * its parent, a page holds `budget` lines (its context line included).
 */
import { describe, expect, it } from 'vitest';
import { PAGES_MAX, splitPages, type SplitPage } from './pages';

type L = { id: string; parent?: L };
const BUDGET = 5;
const line = (id: string, parent?: L): L => ({ id, ...(parent ? { parent } : {}) });
const size = (p: SplitPage<L>) => p.items.length + (p.context ? 1 : 0);
const split = (items: L[], budget = BUDGET, made = 0, hard?: number) =>
  splitPages<L>(
    { key: 's', title: 'Sheet', items },
    {
      parentOf: (t) => t.parent,
      over: (p) => size(p) > budget,
      ...(hard ? { fits: (p: SplitPage<L>) => size(p) <= hard } : {}),
      budget,
      nameOf: (t) => `line ${t.id}`,
    },
    made,
  );
/** Every item once: on a page or in `left`. */
const everyOnce = (r: ReturnType<typeof split>, items: L[]) => {
  const all = [...r.pages.flatMap((p) => p.items), ...r.left].map((t) => t.id);
  expect(all.length).toBe(new Set(all).size);
  expect(all.sort()).toEqual(items.map((t) => t.id).sort());
};
const view = (r: ReturnType<typeof split>) =>
  r.pages.map((p) => [p.key, p.title, p.context?.id ?? '-', p.items.map((t) => t.id).join(' ')]);

describe('splitPages', () => {
  it('a page within budget is left alone', () => {
    const a = line('a');
    const r = split([a, line('b', a)]);
    expect(view(r)).toEqual([['s', 'Sheet', '-', 'a b']]);
    expect(r.markers).toEqual([]);
  });

  it('separate trees over budget: parts, in order', () => {
    const r = split(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => line(id)));
    expect(view(r)).toEqual([
      ['s-p1', 'Sheet (part 1 of 2)', '-', 'a b c d e'],
      ['s-p2', 'Sheet (part 2 of 2)', '-', 'f g'],
    ]);
  });

  it("a line's deadlegs: as many as fit stay, the rest go to a detail page that draws the line again", () => {
    const m = line('m');
    const dls = [1, 2, 3, 4, 5, 6, 7].map((i) => line(`d${i}`, m));
    const r = split([m, ...dls]);
    expect(view(r)).toEqual([
      ['s', 'Sheet', '-', 'm d1 d2 d3 d4'],
      ['s-1', 'Sheet: line m', 'm', 'd5 d6 d7'],
    ]);
    expect(r.markers.map((k) => [k.page, k.on.id, k.to, k.items.length])).toEqual([
      ['s', 'm', 's-1', 3],
    ]);
  });

  it('a busy branch moves whole, its own children with it', () => {
    const m = line('m');
    const b = line('b', m);
    const b1 = line('b1', b);
    const b2 = line('b2', b);
    const r = split([m, line('x', m), b, b1, line('b1a', b1), b2, line('b2a', b2)]);
    expect(view(r)).toEqual([
      ['s', 'Sheet', '-', 'm x b'],
      ['s-1', 'Sheet: line b', 'b', 'b1 b1a b2 b2a'],
    ]);
  });

  it('more deadlegs than a detail page holds: chunks chained by markers', () => {
    const m = line('m');
    const dls = Array.from({ length: 14 }, (_, i) => line(`d${i + 1}`, m));
    const r = split([m, ...dls]);
    expect(view(r).map((v) => [v[0], v[1], v[3]!.split(' ').length])).toEqual([
      ['s', 'Sheet', 5],
      ['s-1', 'Sheet: line m', 4],
      ['s-2', 'Sheet: line m (more 2)', 4],
      ['s-3', 'Sheet: line m (more 3)', 2],
    ]);
    expect(r.markers.map((k) => [k.page, k.to])).toEqual([
      ['s', 's-1'],
      ['s-1', 's-2'],
      ['s-2', 's-3'],
    ]);
    // Every line on exactly one page.
    const all = r.pages.flatMap((p) => p.items.map((t) => t.id));
    expect(all.sort()).toEqual([m, ...dls].map((t) => t.id).sort());
  });

  it('a detail made before the page split into parts belongs to the part holding its line', () => {
    const m = line('m');
    const dls = [1, 2, 3, 4, 5, 6].map((i) => line(`d${i}`, m));
    const roots = [1, 2, 3, 4, 5, 6].map((i) => line(`r${i}`));
    const r = split([m, ...dls, ...roots]);
    expect(view(r)).toEqual([
      ['s-p1', 'Sheet (part 1 of 2)', '-', 'm r1 r2 r3 r4'],
      ['s-p2', 'Sheet (part 2 of 2)', '-', 'r5 r6'],
      ['s-1', 'Sheet: line m', 'm', 'd1 d2 d3 d4'],
      ['s-2', 'Sheet: line m (more 2)', 'm', 'd5 d6'],
    ]);
    expect(r.markers.map((k) => [k.page, k.on.id, k.to])).toEqual([
      ['s-p1', 'm', 's-1'],
      ['s-1', 'm', 's-2'],
    ]);
    expect(r.pages.find((p) => p.key === 's-1')!.origin).toBe('s-p1');
  });

  it('separate trees past the cap: no more parts than the set has room for', () => {
    const items = Array.from({ length: 1000 }, (_, i) => line(`r${i}`));
    const r = split(items, 5, 0, 12);
    expect(r.pages).toHaveLength(PAGES_MAX);
    expect(r.capped).toBe(true);
    expect(r.pages[0]!.title).toBe(`Sheet (part 1 of ${PAGES_MAX})`);
    // The last part keeps what the hard limit holds; the rest is left.
    expect(r.pages.map((p) => p.items.length)).toEqual([...Array(PAGES_MAX - 1).fill(5), 12]);
    expect(r.left).toHaveLength(1000 - 5 * (PAGES_MAX - 1) - 12);
    everyOnce(r, items);
  });

  it('pages made elsewhere count against the cap', () => {
    const items = Array.from({ length: 100 }, (_, i) => line(`r${i}`));
    const r = split(items, 5, PAGES_MAX - 3, 5);
    expect(r.pages).toHaveLength(3);
    expect(r.capped).toBe(true);
    everyOnce(r, items);
    // No room at all: no page, everything left.
    const none = split(items, 5, PAGES_MAX);
    expect(none.pages).toEqual([]);
    expect(none.capped).toBe(true);
    expect(none.left).toHaveLength(100);
  });

  it('a detail page past the cap keeps what the hard limit holds', () => {
    const m = line('m');
    const dls = Array.from({ length: 400 }, (_, i) => line(`d${i}`, m));
    const r = split([m, ...dls], 3, 0, 10);
    expect(r.pages).toHaveLength(PAGES_MAX);
    expect(r.capped).toBe(true);
    for (const p of r.pages) expect(size(p)).toBeLessThanOrEqual(10);
    expect(size(r.pages.at(-1)!)).toBe(10);
    everyOnce(r, [m, ...dls]);
  });

  it('a parent loop drops nothing: each line on it is a root', () => {
    const a: L = { id: 'a' };
    const b: L = { id: 'b', parent: a };
    a.parent = b;
    const c = line('c', b);
    const self: L = { id: 's' };
    self.parent = self;
    const others = Array.from({ length: 6 }, (_, i) => line(`r${i}`));
    const items = [a, b, c, self, ...others];
    const r = split(items);
    everyOnce(r, items);
    expect(r.left).toEqual([]);
    expect(r.capped).toBe(false);
  });

  it('stops at the page cap and says so', () => {
    const m = line('m');
    const dls = Array.from({ length: 400 }, (_, i) => line(`d${i}`, m));
    const r = split([m, ...dls], 3);
    expect(r.pages.length).toBeLessThanOrEqual(PAGES_MAX);
    expect(r.capped).toBe(true);
  });
});
