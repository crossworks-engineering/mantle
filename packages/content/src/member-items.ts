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
  ClientItemFilter,
  ClientItemKind,
  ClientItemRow,
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
  /** Clients' submitted items (client logins C5, decision 5 B). */
  clientRequests: boolean;
};

const NONE: ItemsPlan = {
  own: null,
  withAdmin: false,
  team: null,
  library: false,
  accepted: null,
  clientRequests: false,
};

export function itemsPlan(filter: MemberItemFilter): ItemsPlan {
  switch (filter) {
    case 'all':
      return {
        own: {},
        withAdmin: true,
        team: {},
        library: true,
        accepted: 'above-library',
        clientRequests: true,
      };
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
    case 'client-requests':
      return { ...NONE, clientRequests: true };
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

// ── A client's one list, My requests (client logins C5) ───────────────────

/** Which sources a client's State filter reads: their own items (pills
 *  `private`, `submitted`, `returned`), the ones a reviewer took over
 *  (`with-admin`), and what they wrote that an admin accepted. There is no
 *  team, Library or client-request source: a client reads none of those
 *  here. */
export type ClientItemsPlan = Pick<ItemsPlan, 'own' | 'withAdmin'> & { accepted: boolean };

const CLIENT_NONE: ClientItemsPlan = { own: null, withAdmin: false, accepted: false };

export function clientItemsPlan(filter: ClientItemFilter): ClientItemsPlan {
  switch (filter) {
    case 'all':
      return { own: {}, withAdmin: true, accepted: true };
    case 'private':
      return { ...CLIENT_NONE, own: { reviewStates: ['draft'], sharing: 'private' } };
    case 'submitted':
    case 'returned':
      return { ...CLIENT_NONE, own: { reviewStates: [filter] } };
    case 'with-admin':
      return { ...CLIENT_NONE, withAdmin: true };
    case 'accepted':
      return { ...CLIENT_NONE, accepted: true };
  }
}

/** An own row of My requests (a draft, submitted, returned, or with a
 *  reviewer). Its kind is a client kind: the client's lists read only
 *  those. No level, no staff name. */
export function clientOwnItemRow(row: MemberSpaceItemRow): ClientItemRow {
  return {
    id: row.id,
    type: row.type as ClientItemKind,
    title: row.title,
    icon: row.icon,
    updatedAt: row.updatedAt,
    source: 'own',
    pill: pillOf(row),
    space: row,
    acceptedAt: null,
  };
}

/** An accepted row of My requests: the version accepted, never its level. */
export function clientAcceptedItemRow(row: AcceptedRow): ClientItemRow {
  return {
    id: row.id,
    type: row.type as ClientItemKind,
    title: row.title,
    icon: row.icon,
    updatedAt: row.updatedAt,
    source: 'accepted',
    pill: null,
    space: null,
    acceptedAt: row.acceptedAt,
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

/** Newest `updatedAt` first (ISO strings): the member's one list. */
export function mergeNewestFirst<T extends { updatedAt: string }>(
  sources: readonly PagedSource<T>[],
  page: number,
  pageSize: number,
): Promise<{ items: T[]; total: number }> {
  return mergeSorted(sources, page, pageSize, listSortCompare('edited'));
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
>(sort: 'edited' | 'newest' | 'oldest' | 'title'): (a: T, b: T) => number {
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
