/**
 * Paging one list merged from several sources (item-list alignment): the
 * brain's rows and the caller's own private rows in one list
 * (server/web/lib/admin-private-rows.ts). Moved unchanged out of the
 * member's one list (member-items.ts, removed in workspaces W8d).
 */

/** One source of a merged list: a page of its rows in the list's order, and
 *  its total. */
export type PagedSource<T> = (
  limit: number,
  offset: number,
) => Promise<{ items: T[]; total: number }>;

/** The orders the brain lists sort by (pageOrderBy and its siblings). */
export type ListSort = 'edited' | 'newest' | 'oldest' | 'title';

/** The sources' calls stay at or under this (the content lists cap at 200). */
const CHUNK = 200;

/**
 * Page `page` of the sources merged in `compare` order, which must be the
 * order every source already answers in. The rows of merged page N are among
 * the first N × pageSize of every source, so each source is read that far (in
 * chunks) and no further. Sources run one after another: each opens its own
 * database scope. Ties keep source order, then each source's own order.
 * `total` is the sum.
 */
export async function mergeSorted<T>(
  sources: readonly PagedSource<T>[],
  page: number,
  pageSize: number,
  compare: (a: T, b: T) => number,
): Promise<{ items: T[]; total: number }> {
  const need = page * pageSize;
  const pulled: T[] = [];
  let total = 0;
  for (const source of sources) {
    let got = 0;
    let sourceTotal = 0;
    while (got < need) {
      const limit = Math.min(CHUNK, need - got);
      const res = await source(limit, got);
      sourceTotal = res.total;
      pulled.push(...res.items);
      got += res.items.length;
      if (res.items.length < limit || got >= res.total) break;
    }
    total += sourceTotal;
  }
  const merged = pulled
    .map((item, i) => ({ item, i }))
    .sort((a, b) => compare(a.item, b.item) || a.i - b.i);
  return { items: merged.slice(need - pageSize, need).map((m) => m.item), total };
}

/**
 * The brain lists' sorts as a comparator (pageOrderBy and its siblings):
 * `edited` newest save first, `newest` / `oldest` by creation, `title` A to
 * Z. Title order is the database's collation there; `localeCompare` is the
 * nearest the merge can do, so two titles that sort differently in the two
 * can land a row off by one across a page boundary (never lost from a list
 * that fits one page).
 */
export function listSortCompare<
  T extends { updatedAt: string; createdAt?: string | null; title?: string },
>(sort: ListSort): (a: T, b: T) => number {
  const desc = (x: string, y: string) => (x < y ? 1 : x > y ? -1 : 0);
  switch (sort) {
    case 'newest':
      return (a, b) => desc(a.createdAt ?? '', b.createdAt ?? '');
    case 'oldest':
      return (a, b) => -desc(a.createdAt ?? '', b.createdAt ?? '');
    case 'title':
      return (a, b) => (a.title ?? '').localeCompare(b.title ?? '');
    case 'edited':
      return (a, b) => desc(a.updatedAt, b.updatedAt);
  }
}
