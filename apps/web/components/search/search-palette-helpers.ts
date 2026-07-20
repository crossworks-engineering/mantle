import type { NavItem } from '@/components/layout/nav-items';

/**
 * Pure logic behind the ⌘K search palette, split out for colocated vitest —
 * the component itself stays render-only.
 */

/** One row of `GET /api/search` (nodes mode). */
export type SearchNodeResult = {
  id: string;
  type: string;
  title: string | null;
  path: string | null;
  tags: string[];
  summary: string | null;
  updatedAt: string;
  url: string;
  supersededBy?: { id: string; title: string | null; url: string };
};

/** One row of `GET /api/search?mode=chunks` (passages). */
export type SearchChunkResult = {
  nodeId: string;
  nodeTitle: string | null;
  nodeType: string;
  ordinal: number;
  heading: string | null;
  text: string;
  url: string;
  supersededBy?: { id: string; title: string | null; url: string };
};

/** The endpoint requires a non-trivial query; under this we don't fetch. */
export const MIN_QUERY_LENGTH = 2;

export function isSearchableQuery(q: string): boolean {
  return q.trim().length >= MIN_QUERY_LENGTH;
}

/**
 * Nav rows for the "Go to" group: case-insensitive substring on the name.
 * Empty query ⇒ nothing (the palette is a search box, not a menu).
 */
export function filterNavItems(items: NavItem[], query: string): NavItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return items.filter((item) => item.name.toLowerCase().includes(q));
}

/**
 * Compact "how stale is this" label: 3m / 5h / 2d / 3w / Jan 2026. `now` is
 * injectable for tests; clock skew (updatedAt ahead of now) reads as "now".
 */
export function relativeUpdatedAt(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 60) return `${Math.round(d / 7)}w`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/** Row display title — search results can carry a null/empty title. */
export function displayTitle(title: string | null): string {
  const t = title?.trim();
  return t || 'Untitled';
}
