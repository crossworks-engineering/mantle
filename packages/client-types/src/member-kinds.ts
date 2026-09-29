/**
 * The kinds of item a member works with: what a personal space holds and
 * what the Library lists. The ONE list, for the brain (member-space.ts,
 * member-library.ts) and the client alike (audit M2); a runtime constant, so
 * it is the `@mantle/client-types/member-kinds` subpath.
 */
export const MEMBER_ITEM_KINDS = ['page', 'note', 'draw', 'table', 'file'] as const;
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
