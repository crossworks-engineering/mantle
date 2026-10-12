/**
 * The kinds of item a member works with: what a personal space holds and
 * what the Library lists. The ONE list, for the brain (member-space.ts,
 * member-library.ts) and the client alike (audit M2); a runtime constant, so
 * it is the `@mantle/client-types/member-kinds` subpath.
 *
 * DEPRECATED (workspaces arch A1): derived from the kind registry's `library`
 * field (./kinds) and kept exported for one pair release, then removed. Use
 * the registry.
 */
import {
  ITEM_KINDS,
  kindsWhere,
  type ClientLibraryKind,
  type ItemKind,
  type MemberLibraryKind,
} from './kinds';

/** The registry's `library` kinds that pass `pick`, in the lists' own order. */
function libraryKinds<K extends ItemKind>(pick: (client: boolean) => boolean): readonly K[] {
  const order = (t: ItemKind) => {
    const lib = ITEM_KINDS[t].library as { order: number } | false;
    return lib ? lib.order : 0;
  };
  return kindsWhere<K>((s) => s.library !== false && pick(s.library.client))
    .slice()
    .sort((a, b) => order(a) - order(b));
}

export const MEMBER_ITEM_KINDS = libraryKinds<MemberLibraryKind>(() => true);
export type MemberItemKind = (typeof MEMBER_ITEM_KINDS)[number];

export function isMemberItemKind(v: unknown): v is MemberItemKind {
  return typeof v === 'string' && (MEMBER_ITEM_KINDS as readonly string[]).includes(v);
}

/** The State filter of a member's one list (GET /api/member/items?state=):
 *  `all`, one row pill, `brain` (the rows without a pill), or `by-me` (what
 *  this member wrote and an admin accepted, at any level). A runtime constant
 *  for the same reason as the kinds: the brain parses it, the client offers
 *  it. */
export const MEMBER_ITEM_FILTERS = [
  'all',
  'private',
  'draft',
  'submitted',
  'returned',
  'with-admin',
  'brain',
  'by-me',
] as const;
export type MemberItemFilter = (typeof MEMBER_ITEM_FILTERS)[number];

export function isMemberItemFilter(v: unknown): v is MemberItemFilter {
  return typeof v === 'string' && (MEMBER_ITEM_FILTERS as readonly string[]).includes(v);
}

/** Which items an ADMIN's brain list holds (`?state=` on /api/pages, /notes,
 *  /tables, /draws and the files lists): `brain` (the default, as before),
 *  `private` (the admin's own private items only) or `all` (both, merged in
 *  the list's own order). */
export const ADMIN_LIST_STATES = ['brain', 'private', 'all'] as const;
export type AdminListState = (typeof ADMIN_LIST_STATES)[number];

export function adminListStateOf(v: unknown): AdminListState {
  return typeof v === 'string' && (ADMIN_LIST_STATES as readonly string[]).includes(v)
    ? (v as AdminListState)
    : 'brain';
}

/** The kinds a CLIENT works with in their own space (client logins C5, plan
 *  section 6): pages and notes they write, files they upload. */
export const CLIENT_ITEM_KINDS = libraryKinds<ClientLibraryKind>((client) => client);
export type ClientItemKind = (typeof CLIENT_ITEM_KINDS)[number];

export function isClientItemKind(v: unknown): v is ClientItemKind {
  return typeof v === 'string' && (CLIENT_ITEM_KINDS as readonly string[]).includes(v);
}

/** The State filter of a client's one list, My requests (GET
 *  /api/client/items?state=): `all`, one row pill (`private` a draft,
 *  `submitted`, `returned`, `with-admin` an item a reviewer took over to
 *  work on), or `accepted`. */
export const CLIENT_ITEM_FILTERS = [
  'all',
  'private',
  'submitted',
  'returned',
  'with-admin',
  'accepted',
] as const;
export type ClientItemFilter = (typeof CLIENT_ITEM_FILTERS)[number];

export function isClientItemFilter(v: unknown): v is ClientItemFilter {
  return typeof v === 'string' && (CLIENT_ITEM_FILTERS as readonly string[]).includes(v);
}
