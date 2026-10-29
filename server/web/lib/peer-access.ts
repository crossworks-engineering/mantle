/**
 * What a peer's token may do on /api/mcp (plan page e5b854dd): the body
 * fields the peer routes take, and the check that the login it is to act as
 * exists. `actsAs` is 'owner' (the anchor login), a member login id, or
 * null (a share-only peer). A bound peer acts as its login as that login
 * is now, in its workspaces (no role is kept on the peer).
 */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { authUsers, db, mantlePeers } from '@mantle/db';
import { loginIsAdmin } from '@/lib/auth/admin-seat';

/** A tool name the owner allows on a peer bound to the owner (a risky one:
 *  its policy says `peerRisky`, read by the gate's peer narrower). An unknown name allows
 *  nothing: the surface only checks names it registers. */
const RiskyName = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

export const PeerAccessBody = z.object({
  actsAs: z.union([z.literal('owner'), z.string().uuid(), z.null()]).optional(),
  writeEnabled: z.boolean().optional(),
  allowedRiskyTools: z.array(RiskyName).max(64).optional(),
});

/** The refusal an Admin user who is not the owner gets for a peer that acts
 *  as the owner. */
export const PEER_OWNER_ONLY = 'Only the brain owner may link a brain that acts as the owner.';

/**
 * Whether this change to a peer needs the brain owner (the anchor login,
 * `actor.isOwner`): binding it to the owner, naming risky owner tools on it,
 * or, on a peer bound to the owner now (`boundToOwner`), its Write switch,
 * its risky tools and a new token. Each of these hands its holder the
 * owner's tools; any other Admin user gets 403.
 */
export function peerChangeNeedsOwner(
  change: {
    actsAs?: 'owner' | string | null;
    writeEnabled?: boolean;
    allowedRiskyTools?: readonly string[];
    rotate?: boolean;
  },
  boundToOwner = false,
): boolean {
  if (change.actsAs === 'owner') return true;
  if ((change.allowedRiskyTools?.length ?? 0) > 0) return true;
  if (!boundToOwner) return false;
  return (
    change.writeEnabled !== undefined || change.allowedRiskyTools !== undefined || !!change.rotate
  );
}

/** Whether peer `id` of this brain acts as the owner now (bound to the
 *  anchor login). */
export async function peerBoundToOwner(anchorId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ login: mantlePeers.actsAsLoginId })
    .from(mantlePeers)
    .where(and(eq(mantlePeers.id, id), eq(mantlePeers.ownerId, anchorId)))
    .limit(1);
  return !!row && row.login === anchorId;
}

/** The login a peer is to act as, or an error. */
export async function resolvePeerActsAs(
  anchorId: string,
  actsAs: 'owner' | string | null,
): Promise<{ loginId: string } | null | { error: string }> {
  if (actsAs === null) return null;
  const loginId = actsAs === 'owner' ? anchorId : actsAs;
  const [row] = await db
    .select({
      id: authUsers.id,
      disabledAt: authUsers.disabledAt,
      // Admin membership (loginIsAdmin), never the role column.
      admin: loginIsAdmin(authUsers.id),
    })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  if (!row) return { error: 'No such login.' };
  if (row.disabledAt) return { error: 'That login is disabled.' };
  // Another Admin login is not offered: a peer acts as the owner or as a
  // member, a login that is no Admin user (membership decides). What the bound login reads is its workspaces'.
  if (actsAs !== 'owner' && row.admin) {
    return { error: "Pick 'owner' or a member." };
  }
  return { loginId: row.id };
}
