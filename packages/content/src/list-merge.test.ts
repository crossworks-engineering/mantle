/**
 * The merge that pages one list from several sources (list-merge.ts),
 * without a database.
 */
import { describe, expect, it } from 'vitest';
import { listSortCompare, mergeSorted, type PagedSource } from './list-merge';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

/** A source over a fixed newest-first list that records every call. */
function source(ids: string[], times: number[], calls: Array<[number, number]> = []) {
  const rows = ids.map((id, i) => ({ id, updatedAt: at(times[i]!) }));
  const fn: PagedSource<{ id: string; updatedAt: string }> = async (limit, offset) => {
    calls.push([limit, offset]);
    return { items: rows.slice(offset, offset + limit), total: rows.length };
  };
  return fn;
}

const newestFirst = <T extends { updatedAt: string }>(
  sources: readonly PagedSource<T>[],
  page: number,
  pageSize: number,
) => mergeSorted(sources, page, pageSize, listSortCompare<T>('edited'));

describe('mergeSorted, newest edit first', () => {
  it('interleaves the sources newest first and sums the totals', async () => {
    const a = source(['a1', 'a2', 'a3'], [9, 5, 1]);
    const b = source(['b1', 'b2'], [7, 3]);
    const res = await newestFirst([a, b], 1, 10);
    expect(res.items.map((r) => r.id)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
    expect(res.total).toBe(5);
  });

  it('pages the merged order exactly: no row skipped or repeated', async () => {
    const a = source(['a1', 'a2', 'a3', 'a4'], [10, 8, 6, 4]);
    const b = source(['b1', 'b2', 'b3'], [9, 7, 5]);
    const seen: string[] = [];
    for (let p = 1; p <= 4; p += 1) {
      seen.push(...(await newestFirst([a, b], p, 2)).items.map((r) => r.id));
    }
    expect(seen).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4']);
  });

  it('keeps source order on a tie', async () => {
    const res = await newestFirst([source(['a'], [5]), source(['b'], [5])], 1, 10);
    expect(res.items.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('reads each source only as far as the page needs, in chunks of at most 200', async () => {
    const ids = Array.from({ length: 700 }, (_, i) => `r${i}`);
    const times = ids.map((_, i) => 10_000 - i);
    const calls: Array<[number, number]> = [];
    const small: Array<[number, number]> = [];
    const res = await newestFirst([source(ids, times, calls), source(['s'], [0], small)], 9, 50);
    expect(calls).toEqual([
      [200, 0],
      [200, 200],
      [50, 400],
    ]);
    // A short source stops at its first short answer.
    expect(small).toEqual([[200, 0]]);
    expect(res.items[0]!.id).toBe('r400');
    expect(res.total).toBe(701);
  });

  it('answers an empty page past the end with the full total', async () => {
    const res = await newestFirst([source(['a'], [1])], 3, 10);
    expect(res).toEqual({ items: [], total: 1 });
  });
});

describe('mergeSorted with the brain lists’ sorts', () => {
  const row = (id: string, title: string, created: number, updated: number) => ({
    id,
    title,
    createdAt: at(created),
    updatedAt: at(updated),
  });
  const src =
    <T>(rows: T[]): PagedSource<T> =>
    async (limit, offset) => ({ items: rows.slice(offset, offset + limit), total: rows.length });

  it('merges by title, creation and edit time as each list sorts', async () => {
    const brain = [row('b1', 'Alpha', 1, 9), row('b2', 'Delta', 5, 3)];
    const own = [row('p1', 'Charlie', 3, 6), row('p2', 'bravo', 8, 1)];
    const ids = async (
      sort: 'edited' | 'newest' | 'oldest' | 'title',
      a: typeof brain,
      b: typeof own,
    ) => (await mergeSorted([src(a), src(b)], 1, 10, listSortCompare(sort))).items.map((r) => r.id);
    // Each source answers in the list's own order.
    expect(await ids('title', brain, [own[1]!, own[0]!])).toEqual(['b1', 'p2', 'p1', 'b2']);
    expect(await ids('newest', [brain[1]!, brain[0]!], [own[1]!, own[0]!])).toEqual([
      'p2',
      'b2',
      'p1',
      'b1',
    ]);
    expect(await ids('oldest', brain, own)).toEqual(['b1', 'p1', 'b2', 'p2']);
    expect(await ids('edited', brain, own)).toEqual(['b1', 'p1', 'b2', 'p2']);
  });
});
