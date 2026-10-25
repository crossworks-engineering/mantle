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
/** The links hold: a marker is on a page that draws its line and leads to
 *  a page that exists, one marker a line a page; a detail page's origin
 *  owns its context line and a marker from a page that draws the line
 *  leads to it; a detail page with no origin draws a line on no page. */
const linked = (r: ReturnType<typeof split>): string[] => {
  const bad: string[] = [];
  const at = new Map(r.pages.map((p) => [p.key, p]));
  const owns = (k: string | undefined, t: L) => !!k && !!at.get(k)?.items.includes(t);
  const draws = (k: string, t: L) => owns(k, t) || at.get(k)?.context === t;
  const seen = new Set<string>();
  for (const mk of r.markers) {
    if (!at.has(mk.to)) bad.push(`marker to no page ${mk.to}`);
    if (!draws(mk.page, mk.on))
      bad.push(`marker on ${mk.on.id} on ${mk.page}, which does not draw it`);
    const k = `${mk.page}/${mk.on.id}`;
    if (seen.has(k)) bad.push(`two markers on ${k}`);
    seen.add(k);
  }
  for (const p of r.pages) {
    if (!p.context) continue;
    if (p.origin === undefined) {
      if (!r.left.includes(p.context)) bad.push(`${p.key}: no origin, its line is on a page`);
      continue;
    }
    if (!owns(p.origin, p.context)) bad.push(`${p.key}: origin ${p.origin} does not own its line`);
    if (!r.markers.some((mk) => mk.to === p.key && draws(mk.page, p.context!))) {
      bad.push(`${p.key}: no marker leads to it`);
    }
  }
  return bad;
};

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

  it('lines a chunk moves keep their markers, and the detail pages off them follow', () => {
    // A header, eight branches of two deadlegs each: the branches' deadlegs
    // go to detail pages, then the branches are chunked.
    const h = line('h');
    const branches = Array.from({ length: 8 }, (_, i) => line(`b${i + 1}`, h));
    const items = [h, ...branches.flatMap((b) => [b, line(`${b.id}a`, b), line(`${b.id}b`, b)])];
    const r = split(items);
    everyOnce(r, items);
    expect(linked(r)).toEqual([]);
    expect(view(r).map((v) => [v[0], v[2], v[3]])).toEqual([
      ['s', '-', 'h'],
      ['s-1', 'h', 'b1 b2 b3 b4'],
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => [`s-${i + 1}`, `b${i}`, `b${i}a b${i}b`]),
      ['s-10', 'h', 'b5 b6 b7 b8'],
    ]);
    expect(r.markers.map((k) => [k.page, k.on.id, k.to]).sort()).toEqual(
      [
        ['s', 'h', 's-1'],
        ['s-1', 'h', 's-10'],
        ...[1, 2, 3, 4].map((i) => ['s-1', `b${i}`, `s-${i + 1}`]),
        ...[5, 6, 7, 8].map((i) => ['s-10', `b${i}`, `s-${i + 1}`]),
      ].sort(),
    );
    for (const i of [5, 6, 7, 8]) {
      expect(r.pages.find((p) => p.key === `s-${i + 1}`)!.origin).toBe('s-10');
    }
    expect(r.pages.find((p) => p.key === 's-10')!.origin).toBe('s');
  });

  it('at the cap, a line with a marker stays before one without', () => {
    const x = line('x');
    const kids = [1, 2, 3, 4].map((i) => line(`k${i}`, x));
    const roots = [1, 2, 3, 4, 5, 6].map((i) => line(`r${i}`));
    const items = [...roots, x, ...kids];
    // Room for the page and one detail page; the page holds 4.
    const r = split(items, 3, PAGES_MAX - 2, 4);
    expect(r.capped).toBe(true);
    expect(view(r)[0]).toEqual(['s', 'Sheet', '-', 'r1 r2 r3 x']);
    expect(r.left.map((t) => t.id).slice(0, 3)).toEqual(['r4', 'r5', 'r6']);
    expect(linked(r)).toEqual([]);
    everyOnce(r, items);
  });

  it('at the cap, a line left off its page loses its marker; its detail page takes it as its own', () => {
    const lines = ['x', 'y', 'z'].map((id) => line(id));
    const items = lines.flatMap((l) => [l, line(`${l.id}1`, l), line(`${l.id}2`, l)]);
    // Room for the page and three detail pages; a page holds 2.
    const r = split(items, 2, PAGES_MAX - 4, 2);
    expect(r.capped).toBe(true);
    expect(view(r)[0]).toEqual(['s', 'Sheet', '-', 'x y']);
    // z is on the page that was its detail page, as its own line.
    const z = r.pages.find((p) => p.items[0]?.id === 'z')!;
    expect(z.context).toBeUndefined();
    expect(z.origin).toBeUndefined();
    expect(r.left.map((t) => t.id)).not.toContain('z');
    expect(r.markers.some((mk) => mk.to === z.key)).toBe(false);
    expect(r.markers.map((mk) => mk.on.id).sort()).toEqual(['x', 'y']);
    expect(linked(r)).toEqual([]);
    everyOnce(r, items);
  });

  it('at the cap, a detail page already made off a dropped line stays linked from the drawing', () => {
    // A line X off a root, six lines off X, one line off each of those.
    const r0 = line('R');
    const x = line('X', r0);
    const ks = [0, 1, 2, 3, 4, 5].map((i) => line(`k${i}`, x));
    const items = [r0, x, ...ks.flatMap((k) => [k, line(`g${k.id.slice(1)}`, k)])];
    const r = split(items, 3, 31, 3);
    expect(r.capped).toBe(true);
    // The detail pages of the lines the cap left off X's page still have
    // a marker that leads to them, focused on their line.
    const orphans = r.pages.filter((p) => p.context && p.origin === undefined);
    expect(orphans.length).toBeGreaterThan(0);
    for (const p of orphans) {
      const mk = r.markers.find((m) => m.to === p.key);
      expect(mk, p.key).toBeDefined();
      expect(mk!.focus).toBe(p.context);
    }
    for (const p of r.pages.filter((q) => q.context))
      expect(
        r.markers.some((m) => m.to === p.key),
        p.key,
      ).toBe(true);
    expect(linked(r)).toEqual([]);
    everyOnce(r, items);
  });

  it('fuzzed trees and budgets: every item once, every link holds, the cap holds', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const ri = (n: number) => Math.floor(rnd() * n);
    const bad: string[] = [];
    for (let iter = 0; iter < 1200; iter++) {
      const n = 1 + ri(iter % 20 === 0 ? 800 : 120);
      const shape = ri(4);
      const items: L[] = [];
      for (let i = 0; i < n; i++) {
        const l: L = { id: `x${i}` };
        const p = shape === 0 ? 0.2 : shape === 1 ? 0.9 : 0.6;
        if (i > 0 && rnd() < p) l.parent = items[shape === 1 ? Math.max(0, i - 1 - ri(3)) : ri(i)];
        items.push(l);
      }
      if (rnd() < 0.2 && n > 3) items[0]!.parent = items[n - 1];
      if (rnd() < 0.3) {
        for (let i = n - 1; i > 0; i--) {
          const j = ri(i + 1);
          [items[i], items[j]] = [items[j]!, items[i]!];
        }
      }
      const budget = 2 + ri(25);
      const hard = rnd() < 0.7 ? budget + ri(40) : undefined;
      const made = rnd() < 0.5 ? 0 : ri(PAGES_MAX + 2);
      const r = split([...items], budget, made, hard);
      const tag = `iter ${iter} n=${n} budget=${budget} hard=${hard} made=${made}:`;
      const all = [...r.pages.flatMap((p) => p.items), ...r.left];
      if (all.length !== n || new Set(all).size !== n) bad.push(`${tag} items not once`);
      if (r.pages.length > Math.max(0, PAGES_MAX - made)) bad.push(`${tag} past the cap`);
      if (new Set(r.pages.map((p) => p.key)).size !== r.pages.length) bad.push(`${tag} keys`);
      for (const p of r.pages) {
        if (!r.capped && size(p) > budget) bad.push(`${tag} ${p.key} over budget`);
        if (hard && size(p) > hard) bad.push(`${tag} ${p.key} past the hard limit`);
        if (!p.items.length && !p.context) bad.push(`${tag} ${p.key} empty`);
      }
      if (r.left.length && !r.capped) bad.push(`${tag} left but not capped`);
      for (const b of linked(r)) bad.push(`${tag} ${b}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('many separate trees split in about linear time', () => {
    const run = (k: number) => {
      const items = Array.from({ length: k }, (_, i) => line(`r${i}`));
      const t = performance.now();
      split(items, 20);
      return performance.now() - t;
    };
    run(500);
    // Was quadratic: 4000 roots took over a second. Generous, so a slow
    // machine passes; a return to quadratic does not.
    expect(run(8000)).toBeLessThan(1500);
  });

  it('stops at the page cap and says so', () => {
    const m = line('m');
    const dls = Array.from({ length: 400 }, (_, i) => line(`d${i}`, m));
    const r = split([m, ...dls], 3);
    expect(r.pages.length).toBeLessThanOrEqual(PAGES_MAX);
    expect(r.capped).toBe(true);
  });
});
