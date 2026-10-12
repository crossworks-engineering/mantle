import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getLoginOr401 } from '@/lib/auth';
import { pairCodeStatus } from '@/lib/pair-code';

const Params = z.object({ id: z.string().uuid() });

/**
 * GET /api/auth/pair/[id] — what became of a code this login issued, for the
 * web page's poll: `{ status: 'pending' | 'claimed' | 'expired', deviceLabel }`.
 * A signed-in admin or member (W7e); another login's code reads as expired.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = await getLoginOr401();
  if (login instanceof NextResponse) return login;
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const status = await pairCodeStatus(parsed.data.id, login.loginId);
  return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
}
