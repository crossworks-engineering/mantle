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
import { adminListStateOf, type AdminListState } from '@mantle/client-types/member-kinds';
import {
  listMine,
  listSortCompare,
  mergeSorted,
  type PagedSource,
  type SpaceItemKind,
  type SpaceListSort,
} from '@mantle/content';
import type { SessionUser } from '@/lib/auth';
import { loadPersonalSpaceId } from '@/lib/auth/login-row';
import { inAdminSpace, withTakenFrom, type AdminSpaceCaller } from '@/lib/admin-space';

/** `?state=` of an admin brain list; anything unknown reads as `brain`. */
export function listStateOf(sp: URLSearchParams): AdminListState {
  return adminListStateOf(sp.get('state'));
}

/** A private row is one the brain routes do not serve. */
export function isPrivateRow(row: object): row is AdminPrivateListRow {
  return 'private' in row;
}

/** The caller's own private items of `kind` as rows of a brain list, in
 *  `sort` order; null when the login has no personal space. */
export async function privateRowsSource(
  user: SessionUser,
  kind: SpaceItemKind,
  opts: { q?: string; sort?: SpaceListSort } = {},
): Promise<PagedSource<AdminPrivateListRow> | null> {
  const spaceId = await loadPersonalSpaceId(user.actor.id);
  if (!spaceId) return null;
  const caller: AdminSpaceCaller = { brainId: user.id, loginId: user.actor.id, spaceId, user };
  return async (limit, offset) => {
    const res = await inAdminSpace(caller, () =>
      listMine(spaceId, { kind, q: opts.q, sort: opts.sort, limit, offset }),
    );
    const rows = await withTakenFrom(caller, res.items);
    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        icon: r.icon,
        createdAt: r.createdAt ?? r.updatedAt,
        updatedAt: r.updatedAt,
        private: r,
      })),
      total: res.total,
    };
  };
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
  kind: SpaceItemKind;
  state: AdminListState;
  q?: string;
  sort?: SpaceListSort;
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
  kind: SpaceItemKind,
  opts: { sort?: SpaceListSort; cap?: number } = {},
): Promise<AdminPrivateListRow[]> {
  const priv = await privateRowsSource(user, kind, { sort: opts.sort });
  return priv ? (await priv(Math.min(opts.cap ?? 200, 200), 0)).items : [];
}
