/**
 * Disconnect a connected MCP client — revokes its access by deleting the client
 * (cascades to its tokens + codes). Owner-only; session-gated.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { disconnectClient } from '@/lib/mcp-clients';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const removed = await disconnectClient(user.id, id);
  if (!removed) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
