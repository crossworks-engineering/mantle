/**
 * What a peer's token may do on /api/mcp (plan page e5b854dd): the body
 * fields the peer routes take, and the check that the login it is to act as
 * exists. `actsAs` is 'owner' (the anchor login), a member or client login
 * id, or null (a share-only peer, as before).
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { authUsers, db } from '@mantle/db';

/** A tool name the owner allows on a peer bound to the owner (a risky one:
 *  see PEER_RISKY_TOOL_SLUGS in @mantle/mcp-core). An unknown name allows
 *  nothing: the surface only checks names it registers. */
const RiskyName = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

export const PeerAccessBody = z.object({
  actsAs: z.union([z.literal('owner'), z.string().uuid(), z.null()]).optional(),
  writeEnabled: z.boolean().optional(),
  allowedRiskyTools: z.array(RiskyName).max(64).optional(),
});

/** The login a peer is to act as, with its current role, or an error. */
export async function resolvePeerActsAs(
  anchorId: string,
  actsAs: 'owner' | string | null,
): Promise<{ loginId: string; role: 'admin' | 'member' | 'client' } | null | { error: string }> {
  if (actsAs === null) return null;
  const loginId = actsAs === 'owner' ? anchorId : actsAs;
  const [row] = await db
    .select({ id: authUsers.id, role: authUsers.role, disabledAt: authUsers.disabledAt })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  if (!row) return { error: 'No such login.' };
  if (row.disabledAt) return { error: 'That login is disabled.' };
  if (actsAs !== 'owner' && row.role !== 'member' && row.role !== 'client') {
    return { error: "Pick 'owner', a member or a client." };
  }
  if (row.role !== 'admin' && row.role !== 'member' && row.role !== 'client') {
    return { error: 'That login has no role a peer can act as.' };
  }
  return { loginId: row.id, role: row.role };
}
