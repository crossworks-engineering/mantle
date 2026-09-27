/**
 * Comments on personal items (member logins Phase 2, plan v3.1 section 2d):
 * the discussion on a team-shared item, and on a submitted item between its
 * author and the reviewer.
 *
 * Threads are stored with the brain's id as owner (node-comments.ts, 0147),
 * so a thread survives Accept, when the item moves into the brain. Row
 * security holds the reads (migration 0168): the space role sees the threads
 * on its own items, the team role with the human flag sees the threads on
 * teammates' team-shared items, and nothing below admin sees a brain thread.
 *
 * When commenting is open is the app's rule: the author, while the item is
 * shared with the team or submitted; a teammate, while it is shared. Writing
 * never starts LLM work.
 *
 * Split by audience (audit S6, Jason 2026-09-27): a comment written while the
 * item is shared is the team's (`thread_scope` 'team'); one the author writes
 * while it is private and submitted is review talk ('review'), which
 * teammates never read, even after the item is shared later (0171).
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { asSystem, db, nodeComments, type NodeCommentDbRow } from '@mantle/db';
import { COMMENT_BODY_MAX } from './node-comments';
import { SpaceItemStateError, requireSpace, spaceNotFound } from './member-space-core';
import { getMineRow, getTeamDraftRow } from './member-space';
import { notifySpaceItemChanged } from './member-space-events';

/** Who writes: the member login, with its display-name snapshot. */
export type SpaceCommentAuthor = { loginId: string; name: string };

function cleanBody(body: string): string {
  const text = body.trim().slice(0, COMMENT_BODY_MAX);
  if (!text) throw new SpaceItemStateError('invalid', 'A comment needs some text.');
  return text;
}

async function thread(nodeId: string, teamOnly = false): Promise<NodeCommentDbRow[]> {
  return db
    .select()
    .from(nodeComments)
    .where(
      teamOnly
        ? and(eq(nodeComments.nodeId, nodeId), eq(nodeComments.threadScope, 'team'))
        : eq(nodeComments.nodeId, nodeId),
    )
    .orderBy(asc(nodeComments.createdAt));
}

// ── The author, on an own item (inside withSpace) ────────────────────────────

/** The thread on an own item, oldest first; null when the item is not the
 *  caller's. */
export async function listMineComments(
  spaceId: string,
  id: string,
): Promise<NodeCommentDbRow[] | null> {
  requireSpace(spaceId);
  const row = await getMineRow(spaceId, id);
  return row ? thread(id) : null;
}

/** Comment on an own item: open while it is shared with the team or
 *  submitted for review (409 `not-shared` otherwise). */
export async function addMineComment(
  spaceId: string,
  anchorId: string,
  id: string,
  author: SpaceCommentAuthor,
  body: string,
): Promise<NodeCommentDbRow> {
  requireSpace(spaceId);
  const row = await getMineRow(spaceId, id);
  if (!row) throw spaceNotFound();
  if (row.sharing !== 'team' && row.reviewState !== 'submitted') {
    throw new SpaceItemStateError(
      'not-shared',
      'Share this item with the team or submit it before commenting.',
    );
  }
  const [c] = await db
    .insert(nodeComments)
    .values({
      ownerId: anchorId,
      nodeId: id,
      authorKind: 'member',
      loginId: author.loginId,
      authorName: author.name.trim().slice(0, 200) || 'Member',
      body: cleanBody(body),
      // Private and submitted: review talk, never the team's (S6).
      threadScope: row.sharing === 'team' ? 'team' : 'review',
    })
    .returning();
  if (!c) throw new Error('addMineComment: insert returned no row');
  await notifySpaceItemChanged(id, 'comment');
  return c;
}

/** Delete one of the caller's own comments on an own item. */
export async function deleteMineComment(
  spaceId: string,
  id: string,
  commentId: string,
): Promise<boolean> {
  const { loginId } = requireSpace(spaceId);
  const gone = await db
    .delete(nodeComments)
    .where(
      and(
        eq(nodeComments.id, commentId),
        eq(nodeComments.nodeId, id),
        eq(nodeComments.loginId, loginId),
      ),
    )
    .returning({ id: nodeComments.id });
  if (gone.length) await notifySpaceItemChanged(id, 'comment');
  return gone.length > 0;
}

// ── A teammate, on a team-shared item (inside withTeamDrafts) ────────────────

/** The thread on a teammate's team-shared item; null when it is not shared
 *  (or not there). */
export async function listTeamDraftComments(id: string): Promise<NodeCommentDbRow[] | null> {
  const row = await getTeamDraftRow(id);
  // The team's comments only (row security holds the same line, S6).
  return row ? thread(id, true) : null;
}

/**
 * Comment on a teammate's team-shared item. The team role never writes, so
 * the row is written on the admin pool, and the proof that the item is shared
 * is part of the same statement (audit S4): the insert selects from the item's
 * sharing row, locked, so an unshare or a delete cannot slip in between the
 * check and the write, and the change event commits with the comment, so a
 * failure after it cannot leave a comment the client retries into a
 * duplicate. Attribution comes from the session. The one asSystem write in
 * the personal-space code.
 */
export async function addTeamDraftComment(
  anchorId: string,
  id: string,
  author: SpaceCommentAuthor,
  body: string,
): Promise<NodeCommentDbRow> {
  const text = cleanBody(body);
  const name = author.name.trim().slice(0, 200) || 'Member';
  const c = await asSystem(() =>
    db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        insert into node_comments (owner_id, node_id, author_kind, login_id, author_name, body, thread_scope)
        select ${anchorId}, n.id, 'member', ${author.loginId}, ${name}, ${text}, 'team'
          from space_items si
          join nodes n on n.id = si.node_id
         where si.node_id = ${id}
           and si.sharing = 'team'
           and n.type in ('page', 'note', 'draw', 'table', 'file')
           and not mantle_is_brain_space(n.owner_id)
         for share of si
        returning id`)) as unknown as { id: string }[];
      const newId = rows[0]?.id;
      if (!newId) return null;
      const [inserted] = await tx.select().from(nodeComments).where(eq(nodeComments.id, newId));
      await notifySpaceItemChanged(id, 'comment', undefined, tx);
      return inserted ?? null;
    }),
  );
  if (!c) throw spaceNotFound();
  return c;
}

/**
 * Delete one of the caller's own comments on a teammate's item. No sharing
 * proof (audit S6): the comment is the caller's own, so they may take it back
 * after the item was unshared too. Only on a personal item, never a brain
 * thread; the change event commits with the delete.
 */
export async function deleteTeamDraftComment(
  id: string,
  loginId: string,
  commentId: string,
): Promise<boolean> {
  return asSystem(() =>
    db.transaction(async (tx) => {
      const gone = await tx
        .delete(nodeComments)
        .where(
          and(
            eq(nodeComments.id, commentId),
            eq(nodeComments.nodeId, id),
            eq(nodeComments.authorKind, 'member'),
            eq(nodeComments.loginId, loginId),
            sql`exists (select 1 from nodes n where n.id = ${id} and not mantle_is_brain_space(n.owner_id))`,
          ),
        )
        .returning({ id: nodeComments.id });
      if (gone.length) await notifySpaceItemChanged(id, 'comment', undefined, tx);
      return gone.length > 0;
    }),
  );
}
