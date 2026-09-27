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
