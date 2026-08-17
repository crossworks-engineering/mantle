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
import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import { db, nodeComments, nodes, shares, type NodeCommentDbRow } from '@mantle/db';
import type { NodeComment, NodeCommentAuthorKind } from '@mantle/client-types';
export type { NodeComment, NodeCommentAuthorKind };

export const COMMENT_BODY_MAX = 10_000;

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
};

/** Who is reading — used to compute `mine` per viewer. */
export type CommentViewer = {
  loginId?: string | null;
  contactId?: string | null;
};

export function toNodeCommentDto(row: NodeCommentDbRow, viewer: CommentViewer): NodeComment {
  const mine =
    (row.authorKind === 'owner' && !!viewer.loginId && row.loginId === viewer.loginId) ||
    (row.authorKind === 'member' && !!viewer.contactId && row.contactId === viewer.contactId);
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

/** The thread, oldest first. Empty when the node isn't this owner's. */
export async function listNodeComments(
  ownerId: string,
  nodeId: string,
): Promise<NodeCommentDbRow[]> {
  return db
    .select()
    .from(nodeComments)
    .where(and(eq(nodeComments.ownerId, ownerId), eq(nodeComments.nodeId, nodeId)))
    .orderBy(asc(nodeComments.createdAt));
}

export async function getNodeComment(
  ownerId: string,
  commentId: string,
): Promise<NodeCommentDbRow | null> {
  const [row] = await db
    .select()
    .from(nodeComments)
    .where(and(eq(nodeComments.id, commentId), eq(nodeComments.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/** Append a comment. Returns null when the node doesn't belong to the owner
 *  (the caller turns that into a 404). Body is trimmed and length-capped. */
export async function addNodeComment(
  ownerId: string,
  nodeId: string,
  author: CommentAuthor,
  body: string,
): Promise<NodeCommentDbRow | null> {
  const text = body.trim().slice(0, COMMENT_BODY_MAX);
  if (!text) return null;
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!node) return null;
  const [row] = await db
    .insert(nodeComments)
    .values({
      ownerId,
      nodeId,
      authorKind: author.kind,
      loginId: author.loginId ?? null,
      contactId: author.contactId ?? null,
      agentId: author.agentId ?? null,
      authorName: author.name.trim().slice(0, 200) || 'Unknown',
      body: text,
    })
    .returning();
  if (!row) throw new Error('addNodeComment: insert returned no row');
  return row;
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
    .where(and(eq(nodeComments.id, commentId), eq(nodeComments.ownerId, ownerId)))
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
    .where(and(eq(nodeComments.id, commentId), eq(nodeComments.ownerId, ownerId)))
    .returning({ id: nodeComments.id });
  return rows.length > 0;
}
