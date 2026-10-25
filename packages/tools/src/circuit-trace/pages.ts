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
 * Every item ends on exactly one page; a context line is drawn on its
 * detail pages but belongs to the page it came from.
 */

export type SplitPage<T> = {
  key: string;
  title: string;
  items: T[];
  /** A line drawn here for its children, owned by `origin`. */
  context?: T;
  /** The page a detail page or a part came from. */
  origin?: string;
};

/** A marker on `on`, on page `page`: `items` moved to page `to`. */
export type SplitMarker<T> = { page: string; on: T; to: string; items: T[] };

export type SplitRules<T> = {
  /** The item a line hangs off, if it hangs off one. */
  parentOf: (t: T) => T | undefined;
  /** Whether a page is over budget (lines, equipment, connectors). */
  over: (p: SplitPage<T>) => boolean;
  /** Lines a page holds, its context line included. */
  budget: number;
  /** A short name of a line, for a detail page's title. */
  nameOf: (t: T) => string;
};

/** The pages a set holds (the pid template's own cap). */
export const PAGES_MAX = 40;

export function splitPages<T>(
  first: SplitPage<T>,
  rules: SplitRules<T>,
  /** Pages already made elsewhere in the set: the cap is over all. */
  made = 0,
): { pages: SplitPage<T>[]; markers: SplitMarker<T>[]; capped: boolean } {
  const pages: SplitPage<T>[] = [];
  const markers: SplitMarker<T>[] = [];
  let capped = false;
  let n = 0;
  const queue: SplitPage<T>[] = [first];
  const base = (t: string) => t.replace(/ \((part \d+ of \d+|more \d+)\)$/, '');
  while (queue.length) {
    const page = queue.shift()!;
    pages.push(page);
    if (!rules.over(page)) continue;
    const details: SplitPage<T>[] = [];
    const room = () => made + pages.length + queue.length + details.length < PAGES_MAX;
    /** The page's forest, read afresh after every move. */
    const forest = () => {
      const on = new Set(page.items);
      const parentOn = (t: T) => {
        const p = rules.parentOf(t);
        return p !== undefined && (on.has(p) || p === page.context) ? p : undefined;
      };
      const kids = new Map<T, T[]>();
      for (const t of page.items) {
        const p = parentOn(t);
        if (p !== undefined) kids.set(p, [...(kids.get(p) ?? []), t]);
      }
      const tree = (t: T): T[] => [t, ...(kids.get(t) ?? []).flatMap(tree)];
      const roots = page.items.filter((t) => parentOn(t) === undefined);
      return { kids, tree, roots };
    };
    const detail = (d: Omit<SplitPage<T>, 'key'>, on: T): void => {
      n += 1;
      const key = `${first.key}-${n}`;
      markers.push({ page: page.key, on, to: key, items: d.items });
      details.push({ key, ...d });
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
          .filter(([p]) => p !== page.context && inScope.has(p))
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
          const others = page.items.filter((t) => !direct.includes(t));
          let keep = direct.length - 1;
          while (keep > 0 && rules.over({ ...page, items: [...others, ...direct.slice(0, keep)] }))
            keep -= 1;
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

    // 2. Several trees still over: parts of the page, packed in order.
    const parts: SplitPage<T>[] = [];
    const roots = forest().roots;
    if (!page.context && roots.length > 1 && rules.over(page) && room()) {
      const groups: T[][] = [];
      let cur: T[] = [];
      for (const r of roots) {
        const t = forest().tree(r);
        if (cur.length && rules.over({ ...page, items: [...cur, ...t] })) {
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
        const partOf = (t: T) => parts.find((p) => p.items.includes(t))?.key ?? page.key;
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
        detail(
          {
            title: `${base(page.title)} (more ${k})`,
            items: rest,
            context: page.context,
            origin: page.origin ?? page.key,
          },
          page.context,
        );
      }
    }
    queue.unshift(...parts, ...details);
    if (!parts.length && rules.over(page)) capped = true;
  }
  return { pages, markers, capped };
}
