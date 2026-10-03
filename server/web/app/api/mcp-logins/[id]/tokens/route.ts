/**
 * POST /api/mcp-logins/:id/tokens { label? } : mint a static MCP token for
 * one member or client login (MCP as a login, plan page e5b854dd), for an
 * MCP client without OAuth. The plaintext is in this answer ONCE; only its
 * hash is kept. It works only while the login's MCP switch is on, and ends
 * with the login's sessions (sign out everywhere, password change, disable,
 * role change). Owner only.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { mcpTargetLogin, mintMcpLoginToken } from '@/lib/mcp-auth';
import { firstIssue } from '@/lib/zod-issue';

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({ label: z.string().trim().max(100).optional() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
  const { id, token } = await mintMcpLoginToken({
    loginId: login.id,
    sessionEpoch: login.sessionEpoch,
    label: parsed.data.label || 'MCP client',
    createdBy: user.actor.id,
  });
  return NextResponse.json(
    { id, token },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
