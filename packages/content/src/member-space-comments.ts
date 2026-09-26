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
 */
import { and, asc, eq } from 'drizzle-orm';
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

async function thread(nodeId: string): Promise<NodeCommentDbRow[]> {
  return db
    .select()
    .from(nodeComments)
    .where(eq(nodeComments.nodeId, nodeId))
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
  return row ? thread(id) : null;
}

/**
 * Comment on a teammate's team-shared item. The team role never writes, so
 * once the team-drafts read has proved the item visible to this member, the
 * row is written on the admin pool: attribution comes from the session, the
 * item from the proof. The one asSystem write in the personal-space code.
 */
export async function addTeamDraftComment(
  anchorId: string,
  id: string,
  author: SpaceCommentAuthor,
  body: string,
): Promise<NodeCommentDbRow> {
  const row = await getTeamDraftRow(id);
  if (!row) throw spaceNotFound();
  const text = cleanBody(body);
  const c = await asSystem(async () => {
    const [inserted] = await db
      .insert(nodeComments)
      .values({
        ownerId: anchorId,
        nodeId: id,
        authorKind: 'member',
        loginId: author.loginId,
        authorName: author.name.trim().slice(0, 200) || 'Member',
        body: text,
      })
      .returning();
    return inserted;
  });
  if (!c) throw new Error('addTeamDraftComment: insert returned no row');
  await notifySpaceItemChanged(id, 'comment');
  return c;
}

/** Delete one of the caller's own comments on a teammate's shared item. */
export async function deleteTeamDraftComment(
  id: string,
  loginId: string,
  commentId: string,
): Promise<boolean> {
  const row = await getTeamDraftRow(id);
  if (!row) return false;
  const gone = await asSystem(() =>
    db
      .delete(nodeComments)
      .where(
        and(
          eq(nodeComments.id, commentId),
          eq(nodeComments.nodeId, id),
          eq(nodeComments.authorKind, 'member'),
          eq(nodeComments.loginId, loginId),
        ),
      )
      .returning({ id: nodeComments.id }),
  );
  if (gone.length) await notifySpaceItemChanged(id, 'comment');
  return gone.length > 0;
}
