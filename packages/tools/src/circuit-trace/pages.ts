/**
 * circuit_trace, the split rule: a page that is over the drawing budget is
 * split, never cut. Pure: it moves items (the lines of a page) between
 * pages and says where it moved them; the caller draws the pages.
 *
 * A page's lines form a forest: a line hangs off its parent line (a tee)
 * when the parent is on the same page. Over budget:
 *   1. several trees: they are packed into parts of the page, in order;
 *   2. one tree: the children of one line move to a detail page, where that
 *      line is drawn again as context, and the line keeps a marker that
 *      links there. The group picked is the smallest that brings the page
 *      within budget, else the largest; the page's own context line is
 *      never picked (that would move the whole page);
 *   3. a context line with only childless children: they are cut into
 *      chunks, one detail page each, chained by markers.
 * Every item ends on exactly one page, until the set's page cap: a set
 * holds `PAGES_MAX` pages in all (`made` of them made elsewhere). Once it
 * is reached nothing new is made; a page still over budget keeps what fits
 * within `fits` (the template's hard limits), lines with a marker first,
 * the rest is returned in `left` and `capped` is true. The caller says
 * what is on no page.
 *
 * A marker is always on a page that draws its line, and a detail page's
 * `origin` is the page that owns its context line: when a line moves on,
 * its marker and the detail pages hanging off it follow. When the cap
 * leaves a line off its page, its marker goes; a detail page off it that
 * is still to be split takes the line as its own (the line is then on
 * that page, not left), one already split keeps it as context with no
 * origin (the line is drawn there only) and stays linked from the drawing:
 * a marker on the nearest line above it that the page keeps, else on a
 * free line of a page linked that way before it (a chain), focused on its
 * line. Only when none is free is it reached from the page bar alone.
 *
 * A parent loop (a line that is, through its parents, its own parent) has
 * no root: each line on it is read as a root, so none drops out.
 */
import { SET_LIMITS } from '@mantle/diagram-templates';

export type SplitPage<T> = {
  key: string;
  title: string;
  items: T[];
  /** A line drawn here for its children, owned by `origin`. */
  context?: T;
  /** The page a detail page or a part came from. */
  origin?: string;
};

/** A marker on `on`, on page `page`: `items` moved to page `to`, where
 *  `focus` (else `on`) is drawn. */
export type SplitMarker<T> = { page: string; on: T; to: string; items: T[]; focus?: T };

export type SplitRules<T> = {
  /** The item a line hangs off, if it hangs off one. */
  parentOf: (t: T) => T | undefined;
  /** Whether a page is over budget (lines, equipment, connectors). Must
   *  grow with the items: more items are never less over. */
  over: (p: SplitPage<T>) => boolean;
  /** Whether a page is within the hard limits, for a page the cap leaves
   *  over budget (absent: such a page keeps everything). Grows the same way. */
  fits?: (p: SplitPage<T>) => boolean;
  /** Lines a page holds, its context line included. */
  budget: number;
  /** A short name of a line, for a detail page's title. */
  nameOf: (t: T) => string;
};

/** The pages a set holds (the pid template's own cap). */
export const PAGES_MAX = SET_LIMITS.pages;

/** The largest `k` in [lo, hi] with `ok(k)`, for `ok` true up to some point
 *  and false after it; `lo - 1` when none is. */
function largest(lo: number, hi: number, ok: (k: number) => boolean): number {
  let a = lo - 1;
  let b = hi;
  while (a < b) {
    const mid = Math.ceil((a + b + 1) / 2);
    if (ok(mid)) a = mid;
    else b = mid - 1;
  }
  return a;
}

export function splitPages<T>(
  first: SplitPage<T>,
  rules: SplitRules<T>,
  /** Pages already made elsewhere in the set: the cap is over all. */
  made = 0,
): { pages: SplitPage<T>[]; markers: SplitMarker<T>[]; capped: boolean; left: T[] } {
  const pages: SplitPage<T>[] = [];
  const markers: SplitMarker<T>[] = [];
  const left: T[] = [];
  if (made >= PAGES_MAX) return { pages, markers, capped: true, left: [...first.items] };
  let capped = false;
  let n = 0;
  const queue: SplitPage<T>[] = [first];
  const base = (t: string) => t.replace(/ \((part \d+ of \d+|more \d+)\)$/, '');
  while (queue.length) {
    const page = queue.shift()!;
    pages.push(page);
    if (!rules.over(page)) continue;
    const details: SplitPage<T>[] = [];
    /** Pages the set may still make. */
    const free = () => PAGES_MAX - (made + pages.length + queue.length + details.length);
    const room = () => free() > 0;
    /** The page's forest, read afresh after every move (a move gives the
     *  page a new items array). */
    let read: { items: T[]; f: ReturnType<typeof build> } | undefined;
    const forest = () => {
      if (read?.items !== page.items) read = { items: page.items, f: build() };
      return read.f;
    };
    const build = () => {
      const on = new Set(page.items);
      const parentOn = (t: T) => {
        const p = rules.parentOf(t);
        return p !== undefined && p !== t && (on.has(p) || p === page.context) ? p : undefined;
      };
      const kids = new Map<T, T[]>();
      const parentIn = new Map<T, T>();
      for (const t of page.items) {
        const p = parentOn(t);
        if (p === undefined) continue;
        parentIn.set(t, p);
        const list = kids.get(p);
        if (list) list.push(t);
        else kids.set(p, [t]);
      }
      // A line on a parent loop is a root: walk up from each line; one that
      // comes back to a line already on its walk is on a loop.
      const looped = new Set<T>();
      const done = new Set<T>();
      for (const t of page.items) {
        const walk: T[] = [];
        const onWalk = new Set<T>();
        let at: T | undefined = t;
        while (at !== undefined && !done.has(at) && !onWalk.has(at)) {
          walk.push(at);
          onWalk.add(at);
          at = parentIn.get(at);
        }
        if (at !== undefined && onWalk.has(at)) {
          for (let i = walk.indexOf(at); i < walk.length; i++) looped.add(walk[i]!);
        }
        for (const w of walk) done.add(w);
      }
      for (const t of looped) {
        const p = parentIn.get(t)!;
        kids.set(
          p,
          kids.get(p)!.filter((k) => k !== t),
        );
      }
      const tree = (t: T): T[] => {
        const out: T[] = [];
        const stack = [t];
        while (stack.length) {
          const x = stack.pop()!;
          out.push(x);
          const ks = kids.get(x);
          if (ks) for (let i = ks.length - 1; i >= 0; i--) stack.push(ks[i]!);
        }
        return out;
      };
      const roots = page.items.filter((t) => looped.has(t) || !parentIn.has(t));
      return { kids, tree, roots };
    };
    const detail = (d: Omit<SplitPage<T>, 'key'>, on: T): string => {
      n += 1;
      const key = `${first.key}-${n}`;
      markers.push({ page: page.key, on, to: key, items: d.items });
      details.push({ key, ...d });
      return key;
    };
    /** Lines of this page now drawn on page `to` (or on none): their
     *  markers and the detail pages hanging off them follow. Returns the
     *  lines a detail page took as its own. */
    const orphans: SplitPage<T>[] = [];
    const follow = (gone: Set<T>, to: string | undefined): Set<T> => {
      const taken = new Set<T>();
      for (let i = markers.length - 1; i >= 0; i--) {
        const mk = markers[i]!;
        if (mk.page !== page.key || !gone.has(mk.on)) continue;
        if (to) mk.page = to;
        else markers.splice(i, 1);
      }
      const waiting = new Set(queue);
      for (const d of new Set([...pages, ...queue, ...details])) {
        const line = d.context;
        if (d.origin !== page.key || line === undefined || !gone.has(line)) continue;
        if (to) d.origin = to;
        else if (waiting.has(d)) {
          d.items = [line, ...d.items];
          delete d.context;
          delete d.origin;
          taken.add(line);
        } else {
          delete d.origin;
          orphans.push(d);
        }
      }
      return taken;
    };

    // 1. A tree over budget on its own: the children of one of its lines
    //    move to a detail page (the smallest group that makes it fit, else
    //    the largest), until it fits.
    const fit = (scope: () => T[]) => {
      while (room()) {
        const items = scope();
        if (!rules.over({ ...page, items })) return;
        const { kids, tree } = forest();
        const inScope = new Set(items);
        const excess = Math.max(1, items.length + (page.context ? 1 : 0) - rules.budget);
        const groups = [...kids]
          .filter(([p, ks]) => ks.length && p !== page.context && inScope.has(p))
          .map(([p, ks]) => ({ p, moved: ks.flatMap(tree) }));
        const pick =
          groups
            .filter((g) => g.moved.length >= excess)
            .sort((x, y) => x.moved.length - y.moved.length)[0] ??
          groups.sort((x, y) => y.moved.length - x.moved.length)[0];
        if (!pick) return;
        // Children with no children of their own (a line's deadlegs): as
        // many as fit stay, the rest move.
        const direct = kids.get(pick.p) ?? [];
        if (pick.moved.length === direct.length) {
          const gone = new Set(direct);
          const others = page.items.filter((t) => !gone.has(t));
          const keep = largest(
            1,
            direct.length - 1,
            (k) => !rules.over({ ...page, items: [...others, ...direct.slice(0, k)] }),
          );
          if (keep > 0) pick.moved = direct.slice(keep);
        }
        const moved = new Set(pick.moved);
        page.items = page.items.filter((t) => !moved.has(t));
        detail(
          {
            title: `${base(page.title)}: ${rules.nameOf(pick.p)}`,
            items: pick.moved,
            context: pick.p,
            origin: page.key,
          },
          pick.p,
        );
      }
    };
    if (page.context) fit(() => page.items);
    else for (const r of forest().roots) fit(() => forest().tree(r));

    // 2. Several trees still over: parts of the page, packed in order. The
    //    parts replace the page, so they may take its place and what the
    //    set has left; past that the last part holds the rest.
    const parts: SplitPage<T>[] = [];
    const f = forest();
    const allowed = free() + 1;
    if (!page.context && f.roots.length > 1 && rules.over(page) && allowed > 1) {
      const groups: T[][] = [];
      let cur: T[] = [];
      for (const r of f.roots) {
        const t = f.tree(r);
        if (
          cur.length &&
          groups.length < allowed - 1 &&
          rules.over({ ...page, items: [...cur, ...t] })
        ) {
          groups.push(cur);
          cur = [];
        }
        cur.push(...t);
      }
      if (cur.length) groups.push(cur);
      if (groups.length > 1) {
        groups.forEach((items, i) =>
          parts.push({
            key: `${page.key}-p${i + 1}`,
            title: `${base(page.title)} (part ${i + 1} of ${groups.length})`,
            items,
            ...(page.origin ? { origin: page.origin } : {}),
          }),
        );
        // What this page said and lent now belongs to the part holding it.
        const partAt = new Map<T, string>();
        for (const p of parts) for (const t of p.items) partAt.set(t, p.key);
        const partOf = (t: T) => partAt.get(t) ?? page.key;
        for (const mk of markers) if (mk.page === page.key) mk.page = partOf(mk.on);
        for (const d of details)
          if (d.origin === page.key && d.context) d.origin = partOf(d.context);
        pages.pop();
      }
    }

    // 3. A context line whose children have no children of their own:
    //    chunks, chained by markers.
    if (page.context && rules.over(page) && room()) {
      const ks = forest().kids.get(page.context) ?? [];
      const keep = Math.max(1, rules.budget - 1);
      if (ks.length > keep) {
        const rest = ks.slice(keep);
        const gone = new Set(rest);
        page.items = page.items.filter((t) => !gone.has(t));
        const k = Number(/ \(more (\d+)\)$/.exec(page.title)?.[1] ?? 1) + 1;
        const to = detail(
          {
            title: `${base(page.title)} (more ${k})`,
            items: rest,
            context: page.context,
            // The page that owns the line (none once it is on no page).
            ...(page.origin ? { origin: page.origin } : {}),
          },
          page.context,
        );
        follow(gone, to);
      }
    }
    queue.unshift(...parts, ...details);
    if (parts.length || !rules.over(page)) continue;
    // Still over: the cap stopped the split. What fits stays, in order
    // (lines with a marker first, when they fit).
    capped = true;
    const fits = rules.fits;
    if (!fits || fits(page)) continue;
    const marked = new Set(markers.filter((mk) => mk.page === page.key).map((mk) => mk.on));
    let order = [
      ...page.items.filter((t) => marked.has(t)),
      ...page.items.filter((t) => !marked.has(t)),
    ];
    const most = (ts: T[]) =>
      Math.max(
        0,
        largest(0, ts.length - 1, (k) => fits({ ...page, items: ts.slice(0, k) })),
      );
    let kept = new Set(order.slice(0, most(order)));
    if (!fits({ ...page, items: page.items.filter((t) => kept.has(t)) })) {
      order = page.items;
      kept = new Set(order.slice(0, most(order)));
    }
    const gone = page.items.filter((t) => !kept.has(t));
    page.items = page.items.filter((t) => kept.has(t));
    const taken = follow(new Set(gone), undefined);
    left.push(...gone.filter((t) => !taken.has(t)));
    // A detail page already made off a line the cap left off: a marker
    // still leads there, from the nearest line above it this page keeps,
    // else from a free line of a page linked this way before it (a chain).
    const hosts = new Set(page.items);
    if (page.context !== undefined) hosts.add(page.context);
    const busy = (k: string, t: T) => markers.some((mk) => mk.page === k && mk.on === t);
    const chain: SplitPage<T>[] = [];
    for (const d of orphans) {
      const line = d.context!;
      let host: { page: string; on: T } | undefined;
      const seen = new Set<T>();
      for (let up = rules.parentOf(line); up !== undefined && !seen.has(up);) {
        seen.add(up);
        if (hosts.has(up)) {
          if (!busy(page.key, up)) host = { page: page.key, on: up };
          break;
        }
        up = rules.parentOf(up);
      }
      for (let i = chain.length - 1; !host && i >= 0; i--) {
        const c = chain[i]!;
        const free = [c.context!, ...c.items].find((t) => !busy(c.key, t));
        if (free !== undefined) host = { page: c.key, on: free };
      }
      if (!host) continue;
      markers.push({ ...host, to: d.key, items: [line, ...d.items], focus: line });
      chain.push(d);
    }
    if (!page.items.length && !page.context) {
      // Nothing of it fits: no page, and nothing links to one.
      pages.pop();
      for (let i = markers.length - 1; i >= 0; i--)
        if (markers[i]!.to === page.key) markers.splice(i, 1);
    }
  }
  return { pages, markers, capped, left };
}
