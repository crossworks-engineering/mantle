/**
 * Tree helpers for the /pages hierarchy view (Phase 4a sub-pages). Pure so the
 * grouping rules — top-level detection, orphan-as-root, child ordering — are
 * unit-testable without rendering the client component.
 */

export interface TreeInput {
  id: string;
  parentId: string | null;
  title: string;
}

/**
 * Group pages by parent id for the collapsible tree. The `null` key holds the
 * top-level pages. A page whose `parentId` doesn't resolve to a loaded page is
 * treated as a root (defensive — e.g. its parent fell outside the load limit),
 * so nothing is ever silently dropped from the tree. Children are sorted by
 * title for a stable sidebar.
 *
 * Cycle-safety: if two pages point at each other (A.parent=B, B.parent=A),
 * both have a resolvable parent so neither lands under the `null` key — the
 * recursive renderer starts from `null` and simply never reaches them, so a
 * cycle can't cause infinite recursion (it just hides the cycle). The current
 * API can't create such a cycle, but the renderer stays safe regardless.
 */
export function buildChildrenIndex<T extends TreeInput>(pages: T[]): Map<string | null, T[]> {
  const ids = new Set(pages.map((p) => p.id));
  const m = new Map<string | null, T[]>();
  for (const p of pages) {
    const key = p.parentId && ids.has(p.parentId) ? p.parentId : null;
    const arr = m.get(key) ?? [];
    arr.push(p);
    m.set(key, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.title.localeCompare(b.title));
  return m;
}
