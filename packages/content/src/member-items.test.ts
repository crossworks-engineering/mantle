/**
 * The member's one list (item-list alignment) without a database: the pill a
 * row wears, the sources each State filter reads, and the merge that pages
 * them. The per-source rules are proven by each source's own db tests.
 */
import { describe, expect, it } from 'vitest';
import type { MemberSpaceItemRow } from '@mantle/client-types';
import { MEMBER_ITEM_FILTERS } from '@mantle/client-types/member-kinds';
import {
  acceptedItemRow,
  itemsPlan,
  mergeNewestFirst,
  pillOf,
  spaceItemRow,
  type PagedSource,
} from './member-items';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

function space(over: Partial<MemberSpaceItemRow> = {}): MemberSpaceItemRow {
  return {
    id: 'x',
    type: 'page',
    title: 'X',
    icon: null,
    sharing: 'private',
    reviewState: 'draft',
    submittedAt: null,
    returnedNote: null,
    authorLoginId: null,
    updatedAt: at(0),
    ...over,
  };
}

/** A source over a fixed newest-first list that records every call. */
function source(ids: string[], times: number[], calls: Array<[number, number]> = []) {
  const rows = ids.map((id, i) => ({ id, updatedAt: at(times[i]!) }));
  const fn: PagedSource<{ id: string; updatedAt: string }> = async (limit, offset) => {
    calls.push([limit, offset]);
    return { items: rows.slice(offset, offset + limit), total: rows.length };
  };
  return fn;
}

describe('pillOf', () => {
  it('names the review state first, then who can see a draft', () => {
    expect(pillOf(space())).toBe('private');
    expect(pillOf(space({ sharing: 'team' }))).toBe('draft');
    expect(pillOf(space({ reviewState: 'submitted', sharing: 'team' }))).toBe('submitted');
    expect(pillOf(space({ reviewState: 'returned' }))).toBe('returned');
    expect(pillOf(space({ reviewState: 'with-admin' }))).toBe('with-admin');
    expect(pillOf(space({ reviewState: 'taken' }))).toBe('with-admin');
    expect(pillOf(space({ reviewState: 'accepted' }))).toBeNull();
  });
});

describe('itemsPlan', () => {
  it('reads every source for all, and only the Library side for brain', () => {
    expect(itemsPlan('all')).toEqual({
      own: {},
      withAdmin: true,
      team: {},
      library: true,
      accepted: 'above-library',
    });
    expect(itemsPlan('brain')).toMatchObject({
      own: null,
      team: null,
      withAdmin: false,
      library: true,
      accepted: 'above-library',
    });
    expect(itemsPlan('by-me')).toMatchObject({ library: false, accepted: 'all', own: null });
  });

  it('narrows each space source to exactly the rows that wear the pill', () => {
    // Every combination a space row can be in: the plan for a pill must keep
    // those rows and no others (filter and pill agree).
    const rows = (['private', 'team'] as const).flatMap((sharing) =>
      (['draft', 'submitted', 'returned'] as const).map((reviewState) =>
        space({ sharing, reviewState }),
      ),
    );
    for (const filter of MEMBER_ITEM_FILTERS) {
      const plan = itemsPlan(filter);
      const keeps = (
        o: { reviewStates?: string[]; sharing?: string } | null,
        r: MemberSpaceItemRow,
      ) =>
        !!o &&
        (!o.reviewStates || o.reviewStates.includes(r.reviewState)) &&
        (!o.sharing || o.sharing === r.sharing);
      for (const r of rows) {
        const pill = pillOf(r);
        const wanted = filter === 'all' || filter === pill;
        expect(keeps(plan.own, r), `${filter} own ${r.sharing}/${r.reviewState}`).toBe(wanted);
        // A teammate's row is only ever team-shared.
        if (r.sharing === 'team') {
          expect(keeps(plan.team, r), `${filter} team ${r.reviewState}`).toBe(wanted);
        }
      }
    }
  });
});

describe('row mappers', () => {
  it('keeps the space row for own and team rows', () => {
    const r = spaceItemRow(space({ id: 's1', sharing: 'team' }), 'team');
    expect(r).toMatchObject({ id: 's1', source: 'team', pill: 'draft', space: { id: 's1' } });
  });

  it('opens an accepted item as the Library item when the Library lists it', () => {
    const row = {
      id: 'a',
      type: 'note' as const,
      title: 'A',
      icon: null,
      acceptedAt: null,
      updatedAt: at(1),
    };
    expect(acceptedItemRow({ ...row, audience: 'team' }, ['team', 'client'])).toMatchObject({
      source: 'library',
      byMe: true,
      pill: null,
    });
    expect(acceptedItemRow({ ...row, audience: 'admin' }, ['team', 'client']).source).toBe(
      'accepted',
    );
  });
});

describe('mergeNewestFirst', () => {
  it('interleaves the sources newest first and sums the totals', async () => {
    const a = source(['a1', 'a2', 'a3'], [9, 5, 1]);
    const b = source(['b1', 'b2'], [7, 3]);
    const res = await mergeNewestFirst([a, b], 1, 10);
    expect(res.items.map((r) => r.id)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
    expect(res.total).toBe(5);
  });

  it('pages the merged order exactly: no row skipped or repeated', async () => {
    const a = source(['a1', 'a2', 'a3', 'a4'], [10, 8, 6, 4]);
    const b = source(['b1', 'b2', 'b3'], [9, 7, 5]);
    const seen: string[] = [];
    for (let p = 1; p <= 4; p += 1) {
      seen.push(...(await mergeNewestFirst([a, b], p, 2)).items.map((r) => r.id));
    }
    expect(seen).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4']);
  });

  it('keeps source order on a tie', async () => {
    const res = await mergeNewestFirst([source(['a'], [5]), source(['b'], [5])], 1, 10);
    expect(res.items.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('reads each source only as far as the page needs, in chunks of at most 200', async () => {
    const ids = Array.from({ length: 700 }, (_, i) => `r${i}`);
    const times = ids.map((_, i) => 10_000 - i);
    const calls: Array<[number, number]> = [];
    const small: Array<[number, number]> = [];
    const res = await mergeNewestFirst(
      [source(ids, times, calls), source(['s'], [0], small)],
      9,
      50,
    );
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
    const res = await mergeNewestFirst([source(['a'], [1])], 3, 10);
    expect(res).toEqual({ items: [], total: 1 });
  });
});
