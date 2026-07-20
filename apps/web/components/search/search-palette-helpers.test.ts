import { describe, expect, it } from 'vitest';
import { FileText, type LucideIcon } from 'lucide-react';
import {
  displayTitle,
  filterNavItems,
  isSearchableQuery,
  relativeUpdatedAt,
} from './search-palette-helpers';
import { NODE_TYPE_ICONS, nodeTypeIcon } from './node-type-icons';
// Relative, not `@/…`: the root vitest config has no path alias (type-only
// `@/` imports in the sources are erased and don't hit the resolver).
import { SEARCH_NODE_TYPES } from '../../lib/search-query';
import type { NavItem } from '../layout/nav-items';

const nav = (name: string): NavItem => ({ name, href: `/${name.toLowerCase()}`, icon: FileText });

describe('isSearchableQuery', () => {
  it('needs 2 non-whitespace-trimmed chars', () => {
    expect(isSearchableQuery('')).toBe(false);
    expect(isSearchableQuery(' a ')).toBe(false);
    expect(isSearchableQuery('ab')).toBe(true);
    expect(isSearchableQuery('  ab  ')).toBe(true);
  });
});

describe('filterNavItems', () => {
  const items = [nav('Notes'), nav('Pages'), nav('Tool groups')];

  it('matches case-insensitive substrings', () => {
    expect(filterNavItems(items, 'note').map((i) => i.name)).toEqual(['Notes']);
    expect(filterNavItems(items, 'GROUP').map((i) => i.name)).toEqual(['Tool groups']);
    expect(filterNavItems(items, 'es').map((i) => i.name)).toEqual(['Notes', 'Pages']);
  });

  it('returns nothing for an empty query', () => {
    expect(filterNavItems(items, '')).toEqual([]);
    expect(filterNavItems(items, '   ')).toEqual([]);
  });
});

describe('relativeUpdatedAt', () => {
  const now = Date.parse('2026-07-20T12:00:00Z');
  const at = (iso: string) => relativeUpdatedAt(iso, now);

  it('buckets seconds → minutes → hours → days → weeks → month-year', () => {
    expect(at('2026-07-20T11:59:40Z')).toBe('now');
    expect(at('2026-07-20T11:55:00Z')).toBe('5m');
    expect(at('2026-07-20T09:00:00Z')).toBe('3h');
    expect(at('2026-07-18T12:00:00Z')).toBe('2d');
    expect(at('2026-07-06T12:00:00Z')).toBe('2w');
    // Locale-formatted (short month + year) — build the expectation the same
    // way so the test doesn't assume the runner's locale.
    expect(at('2026-01-05T12:00:00Z')).toBe(
      new Date('2026-01-05T12:00:00Z').toLocaleDateString(undefined, {
        month: 'short',
        year: 'numeric',
      }),
    );
  });

  it('clamps future timestamps (clock skew) to now', () => {
    expect(at('2026-07-20T12:05:00Z')).toBe('now');
  });

  it('tolerates garbage', () => {
    expect(at('not-a-date')).toBe('');
  });
});

describe('displayTitle', () => {
  it('falls back to Untitled', () => {
    expect(displayTitle(null)).toBe('Untitled');
    expect(displayTitle('  ')).toBe('Untitled');
    expect(displayTitle('Printer contract')).toBe('Printer contract');
  });
});

describe('node-type icons', () => {
  it('covers every search type (the Record enforces it; this guards runtime)', () => {
    for (const t of SEARCH_NODE_TYPES) {
      expect(NODE_TYPE_ICONS[t]).toBeTypeOf('object');
      expect(nodeTypeIcon(t)).toBe(NODE_TYPE_ICONS[t]);
    }
  });

  it('defaults unknown types to a file icon', () => {
    const icon: LucideIcon = nodeTypeIcon('mystery_type');
    expect(icon).toBeTruthy();
  });
});
