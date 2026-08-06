'use client';

import { useEffect, useState } from 'react';
import { type NavGroup, type NavItem } from '@mantle/web-ui/layout/nav-items';

/**
 * Client-side nav usage tracking. Every visit to a primary destination bumps a
 * per-href counter in localStorage, and the sidebar ranks each collapsible
 * group's head from it. Purely a personalisation convenience — no server
 * surface, no PII, safe to lose.
 *
 * Counts are read at mount and never watched. Nothing subscribes to writes on
 * purpose; see `useGroupHead` for why a live-ranked menu is the wrong thing.
 */
const KEY = 'mantle_nav_usage_v1';

type Counts = Record<string, number>;

function read(): Counts {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Counts) : {};
  } catch {
    return {};
  }
}

/** Record a visit to a nav href. Takes effect on the next load, by design. */
export function recordNavVisit(href: string): void {
  if (typeof window === 'undefined') return;
  const counts = read();
  counts[href] = (counts[href] ?? 0) + 1;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(counts));
  } catch {
    /* quota/private-mode — ranking just won't persist */
  }
}

/**
 * The head of one collapsible group: the destinations this owner returns to,
 * most-used first. Ties break on the group's cold-start order, then sidebar
 * order — so a brain with no history renders exactly `defaultHead` and drifts
 * toward real behaviour as counts accumulate, with no second code path.
 *
 * Only current items are considered: the counts are keyed by href and outlive
 * the routes they name, so a retired screen keeps its tally and must never win
 * a slot. Reading from `group.items` rather than the store is what guarantees
 * that.
 */
export function groupHead(group: NavGroup): NavItem[] {
  const size = group.headSize ?? 0;
  if (!group.collapsible || size <= 0) return [];
  const counts = read();
  const cold = group.defaultHead ?? [];
  const coldRank = (i: NavItem) => {
    const at = cold.indexOf(i.href);
    return at === -1 ? cold.length : at;
  };
  return [...group.items]
    .sort((a, b) => {
      const byUse = (counts[b.href] ?? 0) - (counts[a.href] ?? 0);
      if (byUse !== 0) return byUse;
      const byCold = coldRank(a) - coldRank(b);
      if (byCold !== 0) return byCold;
      return group.items.indexOf(a) - group.items.indexOf(b);
    })
    .slice(0, size);
}

/** The head before any usage exists: `defaultHead` in order, padded from
 *  sidebar order so its length always equals the ranked head's. */
function coldHead(group: NavGroup): NavItem[] {
  const size = group.headSize ?? 0;
  if (!group.collapsible || size <= 0) return [];
  const byHref = new Map(group.items.map((i) => [i.href, i]));
  const picked: NavItem[] = [];
  for (const href of group.defaultHead ?? []) {
    const item = byHref.get(href);
    if (item && !picked.includes(item)) picked.push(item);
  }
  for (const item of group.items) {
    if (picked.length >= size) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked.slice(0, size);
}

/**
 * A group's head, computed ONCE per mount and deliberately never recomputed
 * while mounted — not when a visit is recorded, not when another tab writes.
 *
 * The freeze is the whole point. A menu that reorders under the cursor is
 * worse than a long one: click Agents, its count rises, and the row you were
 * aiming at slides out from under you. Frozen, muscle memory holds for the
 * session and the order improves quietly on the next load.
 *
 * Returns the cold-start head on the server and on first paint so SSR and
 * hydration agree, then swaps in the ranked head. Both are exactly `headSize`
 * long, so that swap changes labels and never the row count: no layout jump.
 */
export function useGroupHead(group: NavGroup): NavItem[] {
  const [head, setHead] = useState<NavItem[]>(() => coldHead(group));
  useEffect(() => {
    setHead(groupHead(group));
    // Deliberately once per mount; `group` is a module constant, and reacting
    // to EVENT here would reintroduce the moving target described above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return head;
}
