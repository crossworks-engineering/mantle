/**
 * An admin's own private items inside the brain lists (item-list alignment):
 * /api/pages, /api/notes, /api/tables, /api/draws and the files root and
 * Recent lists take `?state=brain|private|all`. `brain` (the default) is the
 * list as it always was, so a client that never asks sees no change; `all`
 * merges the caller's private items into it, in the list's own order;
 * `private` lists them alone.
 *
 * A private row (AdminPrivateListRow) carries the space row under `private`:
 * the item is read and written through /api/admin/space, never the brain
 * route. The rows are read exactly as GET /api/admin/space reads them (the
 * caller's OWN space, inside `withSpace`); nobody else's private items ever
 * appear. Private items have no tags and no parent, so a tag filter or a
 * sub-page level lists none.
 */
import type { AdminPrivateListRow } from '@mantle/client-types';
import {
  adminListStateOf,
  type AdminListState,
  type MemberItemKind,
} from '@mantle/client-types/member-kinds';
import { listSortCompare, mergeSorted, type ListSort, type PagedSource } from '@mantle/content';
import type { SessionUser } from '@/lib/auth';

/** `?state=` of an admin brain list; anything unknown reads as `brain`. */
export function listStateOf(sp: URLSearchParams): AdminListState {
  return adminListStateOf(sp.get('state'));
}

/** A private row is one the brain routes do not serve. */
export function isPrivateRow(row: object): row is AdminPrivateListRow {
  return 'private' in row;
}

/** The caller's own private items of `kind` as rows of a brain list:
 *  none since workspaces W6b (migration 0267). Every personal item is a
 *  brain item now, homed in its login's private workspace, so the brain
 *  list itself serves it to that login (the request scope holds the
 *  private workspace). `?state=private` lists nothing; `all` is the brain
 *  list. No personal space is read. */
export async function privateRowsSource(
  _user: SessionUser,
  _kind: MemberItemKind,
  _opts: { q?: string; sort?: ListSort } = {},
): Promise<PagedSource<AdminPrivateListRow> | null> {
  return null;
}

type Sortable = { updatedAt: string; createdAt?: string | null; title?: string };

/**
 * One page of a brain list with the caller's private rows as `state` asks.
 * `brain` is the brain source alone (one call, as before); `private` the
 * private source alone; `all` both, merged in `sort` order (mergeSorted).
 * `tagged`: a tag filter is on, so there are no private rows.
 */
export async function pageWithPrivate<B extends Sortable>(opts: {
  user: SessionUser;
  kind: MemberItemKind;
  state: AdminListState;
  q?: string;
  sort?: ListSort;
  tagged?: boolean;
  page: number;
  pageSize: number;
  brain: PagedSource<B>;
}): Promise<{ items: Array<B | AdminPrivateListRow>; total: number }> {
  const offset = (opts.page - 1) * opts.pageSize;
  if (opts.state === 'brain') return opts.brain(opts.pageSize, offset);
  const priv = opts.tagged
    ? null
    : await privateRowsSource(opts.user, opts.kind, { q: opts.q, sort: opts.sort });
  if (opts.state === 'private') {
    return priv ? priv(opts.pageSize, offset) : { items: [], total: 0 };
  }
  const sources: PagedSource<B | AdminPrivateListRow>[] = [opts.brain];
  if (priv) sources.push(priv);
  return mergeSorted(
    sources,
    opts.page,
    opts.pageSize,
    listSortCompare<B | AdminPrivateListRow>(opts.sort ?? 'edited'),
  );
}

/** Every private row of `kind` (at most `cap`), for the lists that are not
 *  paged: the pages tree and the files root. */
export async function allPrivateRows(
  user: SessionUser,
  kind: MemberItemKind,
  opts: { sort?: ListSort; cap?: number } = {},
): Promise<AdminPrivateListRow[]> {
  const priv = await privateRowsSource(user, kind, { sort: opts.sort });
  return priv ? (await priv(Math.min(opts.cap ?? 200, 200), 0)).items : [];
}
