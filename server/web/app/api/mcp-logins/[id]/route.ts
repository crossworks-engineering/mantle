/**
 * PATCH /api/mcp-logins/:id { enabled?, writeEnabled? } : turn MCP on or off
 * for one member or client login, and its draft write tools (MCP as a login,
 * plan page e5b854dd). Owner only. Turning MCP off stops the login's OAuth
 * grants and static tokens on their next call (read on every use), and
 * revokes them, its API keys and its peer bindings (access matrix L13).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import {
  accessKeys,
  db,
  mcpLoginAccess,
  mcpLoginTokens,
  oauthAccessTokens,
  oauthAuthCodes,
} from '@mantle/db';
import { lockOauthActor } from '@/lib/oauth-lock';
import { auditKeysEnded, getOwnerOr401 } from '@/lib/auth';
import { mcpTargetLogin } from '@/lib/mcp-auth';
import { auditPeersUnbound, unbindPeersActingAs } from '@/lib/peer-unbind';
import { lockLoginKeys } from '@/lib/access-keys';
import { firstIssue } from '@/lib/zod-issue';

const Params = z.object({ id: z.string().uuid() });
const Body = z
  .object({ enabled: z.boolean().optional(), writeEnabled: z.boolean().optional() })
  .refine((b) => b.enabled !== undefined || b.writeEnabled !== undefined, {
    message: 'nothing to update',
  });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const login = await mcpTargetLogin(params.data.id);
  if (!login) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const set = {
    ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
    ...(parsed.data.writeEnabled !== undefined ? { writeEnabled: parsed.data.writeEnabled } : {}),
    updatedAt: new Date(),
  };
  // Off means off: the login's grants and tokens are revoked, so turning
  // MCP on again later does not bring the old ones back. The switch and the
  // revokes commit together (last check F1), under the login's OAuth lock
  // (verification audit N3), the one a code exchange and a refresh take: a
  // grant minted alongside is revoked here or refused there, and open codes
  // go too, so nothing comes back on. A lock timeout changes nothing. Its
  // API keys and its bound peers end too (access matrix L13): a key was
  // refused while MCP was off but worked again the moment it came back on.
  const endedKeyIds: string[] = [];
  const unboundPeerIds: string[] = [];
  const row = await db.transaction(async (tx) => {
    if (parsed.data.enabled === false) {
      await lockOauthActor(tx, login.id);
      // And the lock a key mint takes (audit LOW-6): a key made at this
      // moment is revoked below, or made after the switch is off.
      await lockLoginKeys(tx, login.id);
    }
    const [saved] = await tx
      .insert(mcpLoginAccess)
      .values({ loginId: login.id, ...set })
      .onConflictDoUpdate({ target: mcpLoginAccess.loginId, set })
      .returning();
    if (parsed.data.enabled === false) {
      const now = new Date();
      await tx
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(and(eq(oauthAccessTokens.actorId, login.id), isNull(oauthAccessTokens.revokedAt)));
      await tx.delete(oauthAuthCodes).where(eq(oauthAuthCodes.actorId, login.id));
      await tx
        .update(mcpLoginTokens)
        .set({ revokedAt: now })
        .where(and(eq(mcpLoginTokens.loginId, login.id), isNull(mcpLoginTokens.revokedAt)));
      const keys = await tx
        .update(accessKeys)
        .set({ revokedAt: now, revokedBy: user.actor.id })
        .where(and(eq(accessKeys.loginId, login.id), isNull(accessKeys.revokedAt)))
        .returning({ id: accessKeys.id });
      endedKeyIds.push(...keys.map((k) => k.id));
      unboundPeerIds.push(...(await unbindPeersActingAs(login.id, tx)));
    }
    return saved;
  });
  // After the commit, as endLoginSessions does: a rolled-back switch leaves
  // no row.
  auditKeysEnded(login.id, user.actor.id, endedKeyIds);
  auditPeersUnbound(login.id, user.actor.id, unboundPeerIds, 'mcp-off');
  return NextResponse.json({
    enabled: row!.enabled,
    writeEnabled: row!.writeEnabled,
    ...(parsed.data.enabled === false ? { peersUnbound: unboundPeerIds.length } : {}),
  });
}
