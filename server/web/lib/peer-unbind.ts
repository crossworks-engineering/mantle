/**
 * End every peer binding to one login: the peers whose token acts as it on
 * /api/mcp (0227) go back to share-only (bound to nobody, write off, no risky
 * tools), as `setPeerAccess(..., { actsAs: null })` leaves them. Their
 * federation grants stay; only acting as the login ends.
 *
 * A bound peer is a credential of that login, like its keys and its OAuth
 * grants, so it ends with them (access matrix L12 and L13): on a password
 * change or reset, "sign out everywhere", an admin's End sessions, disable
 * or role change (endLoginSessions with endKeys), and when an admin turns
 * the login's MCP off. Before, a role check and the MCP switch were read on
 * each call, but nothing ended the binding, so a peer kept acting as a
 * member after End sessions, and came back with MCP turned on again.
 */
import { eq } from 'drizzle-orm';
import { db, mantlePeers } from '@mantle/db';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Unbind the login's peers; returns their ids. Run it in the caller's
 *  transaction when there is one. */
export async function unbindPeersActingAs(
  loginId: string,
  q: Tx | typeof db = db,
): Promise<string[]> {
  const rows = await q
    .update(mantlePeers)
    .set({
      actsAsLoginId: null,
      actsAsRole: null,
      writeEnabled: false,
      allowedRiskyTools: [],
      updatedAt: new Date(),
    })
    .where(eq(mantlePeers.actsAsLoginId, loginId))
    .returning({ id: mantlePeers.id });
  return rows.map((r) => r.id);
}
