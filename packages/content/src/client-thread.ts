/**
 * The client thread on a client-level brain item (client logins C5,
 * decision 8): one discussion that the team, the admins and every client
 * login read and write, while the item is at client level. "At client
 * level" is the union rule (item-level.ts): its own level, or the share it
 * inherits from a folder shared with clients (migration 0205).
 *
 * Stored in node_comments with `thread_scope` 'client', the brain's id as
 * owner. Row security holds the reads (migration 0194): the client role and
 * the team role, with the human flag on (a login's own request, never an
 * agent), read the 'client' comments of a brain item at client level, and
 * nothing of it once the item is raised or lowered. Other scopes on the same
 * item (an admin's 'team' talk) stay admin-only. Run the reads inside
 * `withHumanViewer('client')` or `withHumanViewer('team')`.
 *
 * The level roles never write: a comment is written on the admin pool, and
 * the proof that the item is a brain item at client level is part of the
 * same statement (as addTeamDraftComment does it), so a level change cannot
 * slip in between the check and the write. Attribution comes from the
 * session. Writing never starts LLM work.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  asSystem,
  currentSpaceScope,
  currentViewerLevel,
  db,
  nodeComments,
  nodes,
  type NodeCommentDbRow,
} from '@mantle/db';
import {
  COMMENT_BODY_MAX,
  commentPage,
  type CommentPage,
  type CommentPageQuery,
} from './node-comments';
import { assertThreadRoom, takeClientCommentPlace } from './client-comment-caps';
import { readAtAliasSql, readAtSql } from './item-level';

/** Who writes on the client thread: a client or a member login, with its
 *  display-name snapshot (the route picks it from the session). */
export type ClientThreadAuthor = { kind: 'client' | 'member'; loginId: string; name: string };

/** The reads run on a level role with the human flag (withHumanViewer):
 *  never at admin, never inside a personal space. */
function requireHumanLevel(): void {
  const level = currentViewerLevel();
  if ((level !== 'team' && level !== 'client') || currentSpaceScope()) {
    throw new Error('client thread read outside withHumanViewer');
  }
}

/**
 * The client thread on `nodeId`, oldest first; null when the caller may not
 * read the node at its level, or it is not a brain item at client level (the
 * route answers 404). With `page`: one page of it (the routes page every
 * read, audit I2).
 */
export async function listClientThread(
  anchorId: string,
  nodeId: string,
): Promise<NodeCommentDbRow[] | null>;
export async function listClientThread(
  anchorId: string,
  nodeId: string,
  page: CommentPageQuery,
): Promise<CommentPage | null>;
export async function listClientThread(
  anchorId: string,
  nodeId: string,
  page?: CommentPageQuery,
): Promise<NodeCommentDbRow[] | CommentPage | null> {
  requireHumanLevel();
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, anchorId), readAtSql(['client'])))
    .limit(1);
  if (!node) return null;
  const where = and(eq(nodeComments.nodeId, nodeId), eq(nodeComments.threadScope, 'client'));
  if (page) return commentPage(where, page);
  return db.select().from(nodeComments).where(where).orderBy(asc(nodeComments.createdAt));
}

/**
 * Add to the client thread. Written on the admin pool with the proof in the
 * same statement: the node is this brain's, a workspace item, at client
 * level now (locked for the insert). Null when it is not (404).
 *
 * Capped (audit I2): the thread holds at most THREAD_COMMENT_LIMIT comments
 * (`thread-full`, whoever writes), and a CLIENT login writes at most
 * CLIENT_COMMENTS_PER_DAY a day across every thread (`comment-cap`, counted
 * in the ledger in this transaction). Thrown as SpaceItemStateError.
 */
export async function addClientThreadComment(
  anchorId: string,
  nodeId: string,
  author: ClientThreadAuthor,
  body: string,
): Promise<NodeCommentDbRow | null> {
  const text = body.trim().slice(0, COMMENT_BODY_MAX);
  if (!text) return null;
  const name =
    author.name.trim().slice(0, 200) || (author.kind === 'client' ? 'A client' : 'Member');
  return asSystem(() =>
    db.transaction(async (tx) => {
      // The node first, locked (a level change waits for this transaction):
      // a 404 takes no place of the day.
      const there = (await tx.execute(sql`
        select 1 as ok from nodes n
         where n.id = ${nodeId} and n.owner_id = ${anchorId} and ${readAtAliasSql('n', ['client'])}
           and mantle_workspace_kind(n.type)
         for share of n`)) as unknown as { ok: number }[];
      if (!there.length) return null;
      if (author.kind === 'client') {
        await takeClientCommentPlace(tx, author.loginId, nodeId, 'client');
      } else {
        await assertThreadRoom(tx, nodeId, 'client');
      }
      const rows = (await tx.execute(sql`
        insert into node_comments (owner_id, node_id, author_kind, login_id, author_name, body, thread_scope)
        select ${anchorId}, n.id, ${author.kind}, ${author.loginId}, ${name}, ${text}, 'client'
          from nodes n
         where n.id = ${nodeId}
           and n.owner_id = ${anchorId}
           and ${readAtAliasSql('n', ['client'])}
           and mantle_workspace_kind(n.type)
         for share of n
        returning id`)) as unknown as { id: string }[];
      const newId = rows[0]?.id;
      if (!newId) return null;
      const [inserted] = await tx.select().from(nodeComments).where(eq(nodeComments.id, newId));
      return inserted ?? null;
    }),
  );
}

/** Delete one of the caller's own comments on the client thread (its own
 *  login and kind, scope client, on this brain's node). */
export async function deleteClientThreadComment(
  anchorId: string,
  nodeId: string,
  author: Pick<ClientThreadAuthor, 'kind' | 'loginId'>,
  commentId: string,
): Promise<boolean> {
  const gone = await asSystem(() =>
    db
      .delete(nodeComments)
      .where(
        and(
          eq(nodeComments.id, commentId),
          eq(nodeComments.nodeId, nodeId),
          eq(nodeComments.ownerId, anchorId),
          eq(nodeComments.threadScope, 'client'),
          eq(nodeComments.authorKind, author.kind),
          eq(nodeComments.loginId, author.loginId),
        ),
      )
      .returning({ id: nodeComments.id }),
  );
  return gone.length > 0;
}
