/**
 * A member's ONE list (item-list alignment): their own items, teammates'
 * shared drafts, the Library and what they wrote that an admin accepted
 * above it, newest first, each row wearing a small state pill instead of
 * living behind a source switch.
 *
 * The sources cannot be one SQL query: each runs under its own row rules
 * (own space, team drafts, the team level, the admin pool with the author
 * rule written in). So the route asks each source for its newest rows, in
 * its own scope, and `mergeNewestFirst` interleaves them. The State filter
 * never filters a loaded page: `itemsPlan` pushes it down into each source's
 * own query, so paging and `total` stay exact.
 *
 * Nothing here reads the database; the route supplies the sources.
 */
import type {
  MemberItemFilter,
  MemberItemPill,
  MemberItemRow,
  MemberItemAuthor,
  MemberSpaceItemRow,
} from '@mantle/client-types';
import type { ReviewState, SpaceSharing, ViewerLevel } from '@mantle/db';
import type { AcceptedRow } from './member-accepted';
import type { LibraryAudience, LibraryRow } from './member-library';

/** The pill an own or teammate's row wears: where it stands in review, or,
 *  while it is a draft, who can see it. */
export function pillOf(
  row: Pick<MemberSpaceItemRow, 'sharing' | 'reviewState'>,
): MemberItemPill | null {
  switch (row.reviewState) {
    case 'with-admin':
    case 'taken':
      return 'with-admin';
    case 'submitted':
      return 'submitted';
    case 'returned':
      return 'returned';
    case 'accepted':
      return null;
    case 'draft':
      return row.sharing === 'team' ? 'draft' : 'private';
  }
}

/** Which sources a State filter reads, and each one's own narrowing. Every
 *  pill is the rows `pillOf` gives it, so filtering by a pill and reading
 *  the pills agree. `null` = the source is not read. */
export type ItemsPlan = {
  own: { reviewStates?: ReviewState[]; sharing?: SpaceSharing } | null;
  withAdmin: boolean;
  team: { reviewStates?: ReviewState[] } | null;
  library: boolean;
  /** `above-library`: only accepted items the Library does not list (they
   *  are brain rows there already); `all`: every accepted item (`by-me`). */
  accepted: 'above-library' | 'all' | null;
};

const NONE: ItemsPlan = { own: null, withAdmin: false, team: null, library: false, accepted: null };

export function itemsPlan(filter: MemberItemFilter): ItemsPlan {
  switch (filter) {
    case 'all':
      return { own: {}, withAdmin: true, team: {}, library: true, accepted: 'above-library' };
    case 'private':
      return { ...NONE, own: { reviewStates: ['draft'], sharing: 'private' } };
    case 'draft':
      return {
        ...NONE,
        own: { reviewStates: ['draft'], sharing: 'team' },
        team: { reviewStates: ['draft'] },
      };
    case 'submitted':
    case 'returned':
      return { ...NONE, own: { reviewStates: [filter] }, team: { reviewStates: [filter] } };
    case 'with-admin':
      return { ...NONE, withAdmin: true };
    case 'brain':
      return { ...NONE, library: true, accepted: 'above-library' };
    case 'by-me':
      return { ...NONE, accepted: 'all' };
  }
}

export function spaceItemRow(row: MemberSpaceItemRow, source: 'own' | 'team'): MemberItemRow {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    icon: row.icon,
    summary: null,
    updatedAt: row.updatedAt,
    source,
    pill: pillOf(row),
    audience: null,
    author: null,
    byMe: false,
    space: row,
  };
}

export function libraryItemRow(
  row: LibraryRow,
  extra: { author?: MemberItemAuthor | null; byMe?: boolean } = {},
): MemberItemRow {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    icon: row.icon,
    summary: row.summary,
    updatedAt: row.updatedAt,
    source: 'library',
    pill: null,
    audience: row.audience,
    author: extra.author ?? null,
    byMe: extra.byMe ?? false,
    space: null,
  };
}

/** An accepted row. At a level the reader's Library holds it opens as the
 *  Library item (the brain's version, as its row in the whole list does);
 *  above it, as the version accepted. */
export function acceptedItemRow(
  row: AcceptedRow,
  libraryLevels: readonly LibraryAudience[],
): MemberItemRow {
  const inLibrary = (libraryLevels as readonly ViewerLevel[]).includes(row.audience);
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    icon: row.icon,
    summary: null,
    updatedAt: row.updatedAt,
    source: inLibrary ? 'library' : 'accepted',
    pill: null,
    audience: row.audience,
    author: null,
    byMe: true,
    space: null,
  };
}

/** One source's rows, newest first: `(limit, offset)` in, a slice and the
 *  source's total out. */
export type PagedSource<T> = (
  limit: number,
  offset: number,
) => Promise<{ items: T[]; total: number }>;

/** The deepest page the one list serves: page N reads N pages of rows from
 *  every source, so the depth is bounded (50 × 100 = 5,000 per source). */
export const MEMBER_ITEMS_MAX_PAGE = 100;

/** The sources' calls stay at or under this (the content lists cap at 200). */
const CHUNK = 200;

/**
 * Page `page` of the sources merged newest first (`updatedAt` desc, ISO
 * strings). The rows of merged page N are among the first N × pageSize of
 * every source, so each source is read that far (in chunks) and no further.
 * Sources run one after another: each opens its own database scope. Ties
 * keep source order, then each source's own order. `total` is the sum.
 */
export async function mergeNewestFirst<T extends { updatedAt: string }>(
  sources: readonly PagedSource<T>[],
  page: number,
  pageSize: number,
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
    .sort((a, b) =>
      a.item.updatedAt < b.item.updatedAt
        ? 1
        : a.item.updatedAt > b.item.updatedAt
          ? -1
          : a.i - b.i,
    );
  return { items: merged.slice(need - pageSize, need).map((m) => m.item), total };
}
