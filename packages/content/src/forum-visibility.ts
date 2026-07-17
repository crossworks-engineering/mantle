/**
 * The forum's security boundary as PURE PREDICATES — the single source of
 * truth for who may READ or POST INTO a topic. `forum.ts` derives both its SQL
 * filter (`visibleTopicCond`) and its imperative guards from these, so the
 * rule lives in exactly one place.
 *
 * Why pure predicates: `@mantle/content` has no live-DB test harness (every
 * co-located test is pure-function), and this is the first surface in the
 * product where a query bug leaks one member's content to another. Extracting
 * the rule here makes the boundary exhaustively unit-testable without a DB —
 * see forum-visibility.test.ts. The rework of the turn pipeline must not
 * change these predicates; the tests pin them.
 */

/** Who is looking. Owner sees everything; a member sees 'team' topics + their
 *  own 'private' ones. */
export type ForumViewer = { kind: 'owner' } | { kind: 'member'; contactId: string };

/** Who is writing. Owner and agent may post into any topic; a member is bound
 *  by the same visibility rule as reading. */
export type ForumAuthor =
  | { kind: 'member'; contactId: string }
  | { kind: 'owner'; name: string }
  | { kind: 'agent'; agentId: string; name: string };

/** The only two topic fields the visibility rule depends on. */
export type TopicVisibilityFacts = {
  visibility: 'team' | 'private';
  /** Contact id of the member who created the topic, or null (owner-created). */
  createdByContactId: string | null;
};

/**
 * Can this viewer READ this topic?
 *   - owner: always.
 *   - member: any 'team' topic, or a 'private' topic THEY authored.
 * A private topic authored by the owner (createdByContactId null) is never
 * visible to any member.
 */
export function canViewTopic(viewer: ForumViewer, facts: TopicVisibilityFacts): boolean {
  if (viewer.kind === 'owner') return true;
  if (facts.visibility === 'team') return true;
  return facts.createdByContactId !== null && facts.createdByContactId === viewer.contactId;
}

/**
 * Can this author POST into this topic (visibility-wise)? Owner and agent
 * always may; a member is bound by `canViewTopic`. The CLOSED-topic rule is
 * deliberately NOT here — it's an API-layer concern, because the owner and the
 * agent must still be able to post into a closed topic.
 */
export function canPostToTopic(author: ForumAuthor, facts: TopicVisibilityFacts): boolean {
  if (author.kind !== 'member') return true;
  return canViewTopic({ kind: 'member', contactId: author.contactId }, facts);
}
