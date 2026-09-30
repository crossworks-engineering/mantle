/**
 * Comments on content nodes (tasks first — the table is node-generic, see
 * migration 0147). This lib is the single write path; every surface (owner
 * API, team API, agent tools) goes through it so the attribution rules hold:
 * author identity comes from the AUTHENTICATED caller, never from a request
 * body or model args.
 *
 * DTO mapping: `mine` is viewer-relative, so the lib returns raw records and
 * `toNodeCommentDto` computes `mine` from the viewer the route resolved.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { agents, db, nodeComments, nodes, shares, type NodeCommentDbRow } from '@mantle/db';
import type { NodeComment, NodeCommentAuthorKind } from '@mantle/client-types';
export type { NodeComment, NodeCommentAuthorKind };

export const COMMENT_BODY_MAX = 10_000;

/** Comments one page of a thread holds (client logins C5 audit, I2): the
 *  thread routes answer the newest page, and older ones with `?before=`. */
export const COMMENT_PAGE_SIZE = 100;

/** Which page of a thread: the newest (no `before`), or the one just older
 *  than `before` (the createdAt of the oldest comment shown). */
export type CommentPageQuery = { before?: Date | null };

/** A page of a thread, oldest first; `hasMore` when older comments exist. */
export type CommentPage = { rows: NodeCommentDbRow[]; hasMore: boolean };

/**
 * The newest COMMENT_PAGE_SIZE comments matching `where` (older than
 * `page.before` when given), oldest first. `before` is compared as sent: an
 * ISO time has milliseconds and the column microseconds, so two comments in
 * the same millisecond as the boundary may both fall on the newer side.
 */
export async function commentPage(
  where: SQL | undefined,
  page: CommentPageQuery,
): Promise<CommentPage> {
  const rows = await db
    .select()
    .from(nodeComments)
    .where(and(where, page.before ? lt(nodeComments.createdAt, page.before) : undefined))
    .orderBy(desc(nodeComments.createdAt), desc(nodeComments.id))
    .limit(COMMENT_PAGE_SIZE + 1);
  const hasMore = rows.length > COMMENT_PAGE_SIZE;
  return { rows: rows.slice(0, COMMENT_PAGE_SIZE).reverse(), hasMore };
}

/** NOTIFY channel raised by the migration-0149 triggers on any node_comments
 *  write (payload: JSON {ownerId, nodeId}). Consumed by
 *  server/web/lib/realtime.ts only. */
export const COMMENTS_CHANGED_CHANNEL = 'comments_changed';

/** Who is writing — resolved by the route/tool from the session or surface. */
export type CommentAuthor = {
  kind: NodeCommentAuthorKind;
  /** auth.users id when kind='owner'. */
  loginId?: string | null;
  /** contact node id when kind='member'. */
  contactId?: string | null;
  /** agents id when kind='agent'. */
  agentId?: string | null;
  /** Display-name snapshot ("Jason", the contact's name, the agent's name). */
  name: string;
  /** The snapshot when the comment lands on the CLIENT thread (client
   *  logins C5): what every client login reads, so never a full email.
   *  Absent = `name`. */
  clientName?: string;
};

/** Who is reading — used to compute `mine` per viewer. */
export type CommentViewer = {
  loginId?: string | null;
  contactId?: string | null;
};

export function toNodeCommentDto(row: NodeCommentDbRow, viewer: CommentViewer): NodeComment {
  const mine =
    (row.authorKind === 'owner' && !!viewer.loginId && row.loginId === viewer.loginId) ||
    (row.authorKind === 'member' && !!viewer.contactId && row.contactId === viewer.contactId) ||
    // A member LOGIN (member logins Phase 2) writes as itself, no contact.
    (row.authorKind === 'member' && !!viewer.loginId && row.loginId === viewer.loginId) ||
    // A CLIENT login (client logins C5) writes as itself too.
    (row.authorKind === 'client' && !!viewer.loginId && row.loginId === viewer.loginId);
  return {
    id: row.id,
    nodeId: row.nodeId,
    authorKind: row.authorKind,
    authorName: row.authorName,
    mine,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
  };
}

/**
 * The comment sits on one of the owner's OWN nodes (audit S7). A personal
 * item's thread is stored with the brain's id too (so it survives Accept),
 * but the node belongs to a space: without this an admin who knows the id
 * would read, edit or delete a member's thread after it went private.
 */
const onOwnersNode = (ownerId: string) =>
  inArray(
    nodeComments.nodeId,
    db.select({ id: nodes.id }).from(nodes).where(eq(nodes.ownerId, ownerId)),
  );

/** Which of a node's threads the owner reads: every scope (the default), or
 *  only the client thread (`thread_scope` 'client', client logins C6: what
 *  the team and every client login read on a client-level item). */
export type NodeCommentScope = 'client';

/** The thread, oldest first. Empty when the node isn't this owner's. With
 *  `page`: one page of it (the owner route pages every read). With
 *  `scope: 'client'`: only the client thread. */
export async function listNodeComments(
  ownerId: string,
  nodeId: string,
): Promise<NodeCommentDbRow[]>;
export async function listNodeComments(
  ownerId: string,
  nodeId: string,
  page: CommentPageQuery,
  opts?: { scope?: NodeCommentScope },
): Promise<CommentPage>;
export async function listNodeComments(
  ownerId: string,
  nodeId: string,
  page?: CommentPageQuery,
  opts: { scope?: NodeCommentScope } = {},
): Promise<NodeCommentDbRow[] | CommentPage> {
  const where = and(
    eq(nodeComments.ownerId, ownerId),
    eq(nodeComments.nodeId, nodeId),
    onOwnersNode(ownerId),
    opts.scope === 'client' ? eq(nodeComments.threadScope, 'client') : undefined,
  );
  if (page) return commentPage(where, page);
  return db.select().from(nodeComments).where(where).orderBy(asc(nodeComments.createdAt));
}

export async function getNodeComment(
  ownerId: string,
  commentId: string,
): Promise<NodeCommentDbRow | null> {
  const [row] = await db
    .select()
    .from(nodeComments)
    .where(
      and(eq(nodeComments.id, commentId), eq(nodeComments.ownerId, ownerId), onOwnersNode(ownerId)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Append a comment. Returns null when the node doesn't belong to the owner
 * (the caller turns that into a 404). Body is trimmed and length-capped.
 *
 * The thread it joins is decided in the insert itself (client logins C5,
 * decision 8): on an item at CLIENT level a person's comment is the client
 * thread (`thread_scope` 'client', stored with `clientName`), which the
 * team and every client login read; anything else, and every agent's
 * comment, stays 'team' (admins only on a brain item). A level change
 * cannot land between the check and the write.
 */
export async function addNodeComment(
  ownerId: string,
  nodeId: string,
  author: CommentAuthor,
  body: string,
): Promise<NodeCommentDbRow | null> {
  const text = body.trim().slice(0, COMMENT_BODY_MAX);
  if (!text) return null;
  const name = author.name.trim().slice(0, 200) || 'Unknown';
  const clientName = (author.clientName ?? author.name).trim().slice(0, 200) || 'Unknown';
  // An agent never writes into what clients read.
  const onClientThread = author.kind === 'agent' ? sql`false` : sql`n.audience = 'client'`;
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      insert into node_comments
        (owner_id, node_id, author_kind, login_id, contact_id, agent_id, author_name, body, thread_scope)
      select ${ownerId}, n.id, ${author.kind}, ${author.loginId ?? null}, ${author.contactId ?? null},
             ${author.agentId ?? null},
             case when ${onClientThread} then ${clientName} else ${name} end,
             ${text},
             case when ${onClientThread} then 'client' else 'team' end
        from nodes n
       where n.id = ${nodeId} and n.owner_id = ${ownerId}
       for share of n
      returning id`)) as unknown as { id: string }[];
    const newId = rows[0]?.id;
    if (!newId) return null;
    const [row] = await tx.select().from(nodeComments).where(eq(nodeComments.id, newId));
    if (!row) throw new Error('addNodeComment: insert returned no row');
    return row;
  });
}

/**
 * Resolve a calling agent's row for comment attribution — id for the FK,
 * display name for the snapshot. The tool context only carries the slug;
 * without this lookup every agent comment would render its slug and leave
 * `agent_id` NULL (dead FK). Null when the slug doesn't resolve (MCP or
 * background callers with no agent row).
 */
export async function resolveAgentAuthor(
  ownerId: string,
  slug: string,
): Promise<{ agentId: string; name: string } | null> {
  const [row] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, slug)))
    .limit(1);
  return row ? { agentId: row.id, name: row.name || slug } : null;
}

/** Edit a comment's body (stamps edited_at). Caller enforces authorship. */
export async function updateNodeComment(
  ownerId: string,
  commentId: string,
  body: string,
): Promise<NodeCommentDbRow | null> {
  const text = body.trim().slice(0, COMMENT_BODY_MAX);
  if (!text) return null;
  const [row] = await db
    .update(nodeComments)
    .set({ body: text, editedAt: new Date() })
    .where(
      and(eq(nodeComments.id, commentId), eq(nodeComments.ownerId, ownerId), onOwnersNode(ownerId)),
    )
    .returning();
  return row ?? null;
}

/**
 * True when the node has an ACTIVE share — the same visibility rule as every
 * team-workspace listing (team-hub.ts): what a member may read, a member may
 * comment on. The team comment routes gate on this so a token holder can't
 * write into arbitrary node ids.
 */
export async function isNodeTeamVisible(ownerId: string, nodeId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: shares.id })
    .from(shares)
    .where(
      and(
        eq(shares.ownerId, ownerId),
        eq(shares.nodeId, nodeId),
        isNull(shares.revokedAt),
        or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return !!row;
}

/** Delete a comment. Caller enforces authorship/admin rules. */
export async function deleteNodeComment(ownerId: string, commentId: string): Promise<boolean> {
  const rows = await db
    .delete(nodeComments)
    .where(
      and(eq(nodeComments.id, commentId), eq(nodeComments.ownerId, ownerId), onOwnersNode(ownerId)),
    )
    .returning({ id: nodeComments.id });
  return rows.length > 0;
}
