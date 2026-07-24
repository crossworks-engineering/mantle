'use client';

import { useEffect, useState } from 'react';
import { ALL_NAV_ITEMS, type NavItem } from '@mantle/web-ui/layout/nav-items';

/**
 * Client-side nav usage tracking. Every time the user lands on a primary nav
 * destination we bump a per-href counter in localStorage; the footer quick-menu
 * ranks by it to surface the user's actual top menus. Purely a personalisation
 * convenience — no server surface, no PII, safe to lose.
 */
const KEY = 'mantle_nav_usage_v1';
const EVENT = 'mantle-nav-usage';

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

/** Record a visit to a nav href, then notify listeners in this tab. */
export function recordNavVisit(href: string): void {
  if (typeof window === 'undefined') return;
  const counts = read();
  counts[href] = (counts[href] ?? 0) + 1;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(counts));
  } catch {
    /* quota/private-mode — ranking just won't persist */
  }
  window.dispatchEvent(new Event(EVENT));
}

/**
 * The top `count` nav items by usage, most-used first. Falls back to sidebar
 * order for ties and to fill the slate when the user hasn't clicked around yet,
 * so the menu is never sparse. Only real, current nav items are returned (stale
 * hrefs from renamed routes are ignored).
 */
export function topNavItems(count: number): NavItem[] {
  const counts = read();
  const ranked = [...ALL_NAV_ITEMS].sort((a, b) => {
    const diff = (counts[b.href] ?? 0) - (counts[a.href] ?? 0);
    if (diff !== 0) return diff;
    return ALL_NAV_ITEMS.indexOf(a) - ALL_NAV_ITEMS.indexOf(b); // stable: sidebar order
  });
  return ranked.slice(0, count);
}

/** Reactive top-N nav items: recomputes when a visit is recorded (same tab) or
 *  the store changes in another tab. Returns [] on the server / first paint to
 *  keep SSR and hydration in lockstep, then fills in after mount. */
export function useTopNavItems(count: number): NavItem[] {
  const [items, setItems] = useState<NavItem[]>([]);
  useEffect(() => {
    const update = () => setItems(topNavItems(count));
    update();
    window.addEventListener(EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, [count]);
  return items;
}
