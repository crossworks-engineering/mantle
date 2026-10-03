/**
 * DELETE /api/mcp-logins/:id/tokens/:tokenId : revoke one static MCP token
 * of a member or client login (plan page e5b854dd). Owner only. The token
 * stops on its next call.
 */
import { NextResponse } from '@/server/http-compat';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, mcpLoginTokens } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';

const Params = z.object({ id: z.string().uuid(), tokenId: z.string().uuid() });

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; tokenId: string }> },
) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const [row] = await db
    .update(mcpLoginTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mcpLoginTokens.id, params.data.tokenId),
        eq(mcpLoginTokens.loginId, params.data.id),
        isNull(mcpLoginTokens.revokedAt),
      ),
    )
    .returning({ id: mcpLoginTokens.id });
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
