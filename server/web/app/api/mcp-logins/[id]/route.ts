/**
 * PATCH /api/mcp-logins/:id { enabled?, writeEnabled? } : turn MCP on or off
 * for one member or client login, and its draft write tools (MCP as a login,
 * plan page e5b854dd). Owner only. Turning MCP off stops the login's OAuth
 * grants and static tokens on their next call (read on every use).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { db, mcpLoginAccess, mcpLoginTokens, oauthAccessTokens, oauthAuthCodes } from '@mantle/db';
import { lockOauthActor } from '@/lib/oauth-lock';
import { getOwnerOr401 } from '@/lib/auth';
import { mcpTargetLogin } from '@/lib/mcp-auth';
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
  const [row] = await db
    .insert(mcpLoginAccess)
    .values({ loginId: login.id, ...set })
    .onConflictDoUpdate({ target: mcpLoginAccess.loginId, set })
    .returning();
  // Off means off: the login's grants and tokens are revoked, so turning
  // MCP on again later does not bring the old ones back.
  // Under the login's OAuth lock (verification audit N3), the one a code
  // exchange and a refresh take: a grant minted alongside is revoked here or
  // refused there, and open codes go too, so nothing comes back on.
  if (parsed.data.enabled === false) {
    const now = new Date();
    await db.transaction(async (tx) => {
      await lockOauthActor(tx, login.id);
      await tx
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(and(eq(oauthAccessTokens.actorId, login.id), isNull(oauthAccessTokens.revokedAt)));
      await tx.delete(oauthAuthCodes).where(eq(oauthAuthCodes.actorId, login.id));
      await tx
        .update(mcpLoginTokens)
        .set({ revokedAt: now })
        .where(and(eq(mcpLoginTokens.loginId, login.id), isNull(mcpLoginTokens.revokedAt)));
    });
  }
  return NextResponse.json({ enabled: row!.enabled, writeEnabled: row!.writeEnabled });
}
