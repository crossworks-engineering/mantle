/**
 * DELETE /api/member/mcp/clients/:id: a member disconnects one of THEIR OWN
 * MCP clients (team apps Phase 1). Only this member's grants on that client
 * end (lib/mcp-clients.ts disconnectLoginClient, under the login's OAuth
 * lock); the client registration and every other login's grants stay. A
 * client this member holds no live grant on is a plain 404.
 */
import { NextResponse } from '@/server/http-compat';
import { isUuid } from '@mantle/std';
import { getMemberOr401 } from '@/lib/auth';
import { disconnectLoginClient } from '@/lib/mcp-clients';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const removed = await disconnectLoginClient(member.anchorId, member.loginId, id.toLowerCase());
  if (!removed) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
