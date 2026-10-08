/**
 * End every peer binding to one login: the peers whose token acts as it on
 * /api/mcp (0227) stop acting as anyone. Their federation grants stay.
 *
 * A bound peer is a credential of that login, like its keys and its OAuth
 * grants, so it ends with them (access matrix L12 and L13): on a password
 * change or reset, "sign out everywhere", an admin's End sessions, disable
 * or role change (endLoginSessions with endKeys), and when an admin turns
 * the login's MCP off. Owner-bound peers too, as the owner's keys are.
 *
 * The peer keeps its Write switch and its allowed risky tools, and the
 * ended binding is remembered (0238), so binding it to the same login again
 * restores them in one step (setPeerAccess). Nothing reads those to grant:
 * a peer acts only through acts_as_login_id.
 */
import { eq, isNotNull, and, sql } from 'drizzle-orm';
import { db, mantlePeers } from '@mantle/db';
import { auditFireAndForget } from './audit';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Unbind the login's peers; returns their ids. Run it in the caller's
 *  transaction when there is one, and audit the ids once it commits
 *  (auditPeersUnbound). */
export async function unbindPeersActingAs(
  loginId: string,
  q: Tx | typeof db = db,
): Promise<string[]> {
  const rows = await q
    .update(mantlePeers)
    .set({
      endedActsAsLoginId: sql`${mantlePeers.actsAsLoginId}`,
      endedActsAsRole: sql`${mantlePeers.actsAsRole}`,
      actsAsLoginId: null,
      actsAsRole: null,
      updatedAt: new Date(),
    })
    .where(and(eq(mantlePeers.actsAsLoginId, loginId), isNotNull(mantlePeers.actsAsRole)))
    .returning({ id: mantlePeers.id });
  return rows.map((r) => r.id);
}

/** One `peer.unbound` row per peer a session end or the MCP switch
 *  unbound (audit LOW-5). Call it after the unbinding transaction commits. */
export function auditPeersUnbound(
  loginId: string,
  actorId: string,
  peerIds: readonly string[],
  reason: 'sessions-ended' | 'mcp-off',
): void {
  for (const peerId of peerIds) {
    auditFireAndForget({
      actorId,
      actorEmail: reason === 'mcp-off' ? 'mcp-switch' : 'session-end',
      action: 'peer.unbound',
      detail: { peerId, loginId, reason },
    });
  }
}
