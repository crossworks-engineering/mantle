import { describe, expect, it, afterEach } from 'vitest';
import { Bot, Palette, User, type LucideIcon } from 'lucide-react';
import type { NavGroup } from '@mantle/web-ui/layout/nav-items';
import { groupHead } from './nav-usage';

/**
 * The head is what a folded group shows, so getting it wrong is invisible in
 * types and obvious to the user. These pin the three rules that are easy to
 * regress: cold start is the authored list, usage overrides it, and a href
 * that no longer exists can never take a slot.
 */

const icon = Bot as LucideIcon;

function group(overrides: Partial<NavGroup> = {}): NavGroup {
  return {
    label: 'Settings',
    collapsible: true,
    headSize: 3,
    defaultHead: ['/b', '/c'],
    items: [
      { name: 'A', href: '/a', icon },
      { name: 'B', href: '/b', icon: Palette as LucideIcon },
      { name: 'C', href: '/c', icon: User as LucideIcon },
      { name: 'D', href: '/d', icon },
    ],
    ...overrides,
  };
}

/** Stand in for the browser store `groupHead` reads. */
function withCounts(counts: Record<string, number>) {
  const store = new Map<string, string>([['mantle_nav_usage_v1', JSON.stringify(counts)]]);
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('groupHead', () => {
  it('is the authored cold-start list when nothing has been visited', () => {
    // No window at all: the server render, and a brain with no history.
    expect(groupHead(group()).map((i) => i.href)).toEqual(['/b', '/c', '/a']);
  });

  it('pads the cold head from sidebar order to reach headSize', () => {
    // defaultHead names two, headSize is three, so '/a' fills the slot — the
    // ranked and cold heads must be the same length or the swap after mount
    // would change the row count and jump the layout.
    expect(groupHead(group())).toHaveLength(3);
  });

  it('puts real usage ahead of the authored order', () => {
    withCounts({ '/d': 9, '/a': 4 });
    expect(groupHead(group()).map((i) => i.href)).toEqual(['/d', '/a', '/b']);
  });

  it('breaks ties on the authored order, then sidebar order', () => {
    withCounts({ '/a': 2, '/b': 2, '/c': 2, '/d': 2 });
    // All equal, so defaultHead wins first ('/b','/c'), then sidebar order.
    expect(groupHead(group()).map((i) => i.href)).toEqual(['/b', '/c', '/a']);
  });

  it('ignores counts for hrefs the group no longer contains', () => {
    // Counts are keyed by href and outlive the routes they name: /settings/security
    // was retired with a tally already on it. A stale winner must not take a slot.
    withCounts({ '/gone': 999, '/d': 3 });
    const head = groupHead(group());
    expect(head.map((i) => i.href)).toEqual(['/d', '/b', '/c']);
    expect(head.some((i) => i.href === '/gone')).toBe(false);
  });

  it('returns nothing for a group that does not fold', () => {
    expect(groupHead(group({ collapsible: false }))).toEqual([]);
    expect(groupHead(group({ headSize: 0 }))).toEqual([]);
  });

  it('never returns more than the group holds', () => {
    expect(groupHead(group({ headSize: 99 }))).toHaveLength(4);
  });
});
