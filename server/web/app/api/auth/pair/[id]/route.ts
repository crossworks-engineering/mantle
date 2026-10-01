import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { pairCodeStatus } from '@/lib/pair-code';

const Params = z.object({ id: z.string().uuid() });

/**
 * GET /api/auth/pair/[id] — what became of a code this login issued, for the
 * web page's poll: `{ status: 'pending' | 'claimed' | 'expired', deviceLabel }`.
 * Owner session required; another login's code reads as expired.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof NextResponse) return user;
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const status = await pairCodeStatus(parsed.data.id, user.actor.id);
  return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
}
