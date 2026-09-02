/**
 * Forum · shared spine. The two SQL predicates every read shares, the cursor
 * key, the title bound, and the one true member-name resolver.
 *
 * `memberName` lives here rather than in a route because forum author names
 * are resolved from the contact node and are NEVER caller-supplied: a caller
 * that could name itself could impersonate another member.
 */
import { and, eq, ilike, or, sql as dsql } from 'drizzle-orm';
import { db, forumTopics, nodes } from '@mantle/db';
import type { ForumViewer } from '../forum-visibility';

export const TITLE_MAX = 200;

/** SQL form of the read-visibility rule for the LIST/GET queries. MUST mirror
 *  `canViewTopic` (forum-visibility.ts) — that pure predicate is the source of
 *  truth and is the belt to this SQL's suspenders (getForumTopic re-checks it
 *  post-fetch). Owner ⇒ no filter (sees all); member ⇒ 'team' OR own topic. */
export function visibleTopicCond(viewer: ForumViewer) {
  if (viewer.kind === 'owner') return undefined;
  return or(
    eq(forumTopics.visibility, 'team'),
    eq(forumTopics.createdByContactId, viewer.contactId),
  );
}

/** SQL for the forum topic search: matches the topic TITLE, or any non-pending
 *  post BODY in the topic (so "find the thread where X was discussed" works,
 *  not just title hits). Case-insensitive substring. Undefined when no query. */
export function topicSearchCond(query?: string) {
  const q = query?.trim();
  if (!q) return undefined;
  const like = `%${q}%`;
  return or(
    ilike(forumTopics.title, like),
    dsql`exists (
      select 1 from forum_posts p
      where p.topic_id = ${forumTopics.id}
        and p.status <> 'pending'
        and p.body ilike ${like}
    )`,
  );
}

/** Resolve a member's display name from their contact node — the one true
 *  source; never caller-supplied. Throws if the contact is gone (a live team
 *  token cannot outlive its contact, so this indicates a revoked caller). */
export async function memberName(ownerId: string, contactId: string): Promise<string> {
  const [row] = await db
    .select({ title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.id, contactId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!row) throw new Error('forum: contact not found');
  return row.title ?? '(unnamed contact)';
}

/** The reader id a viewer's cursors are keyed by (owner cursors use ownerId). */
export function readerIdOf(ownerId: string, viewer: ForumViewer): string {
  return viewer.kind === 'owner' ? ownerId : viewer.contactId;
}
