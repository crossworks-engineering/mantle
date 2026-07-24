import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { rotateInboundToken } from '@mantle/content';

/** Mint a fresh inbound token for this peer. Returns the plaintext ONCE — the
 *  old token stops working immediately, so the peer must be re-issued this. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const token = await rotateInboundToken(user.id, id);
  if (!token) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ inboundToken: token });
}
