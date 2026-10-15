import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { publicLoginCaller, unauthorizedRefusal } from '@/lib/auth';
import { pairCodeStatus } from '@/lib/pair-code';
import { CACHE_CONTROL } from '@/lib/cache-control';

const Params = z.object({ id: z.string().uuid() });

/**
 * GET /api/auth/pair/[id] — what became of a code this login issued, for the
 * web page's poll: `{ status: 'pending' | 'claimed' | 'expired', deviceLabel }`.
 * A signed-in admin or member (W7e); another login's code reads as expired.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  // A public row: the login the pipeline answers at this read (A4 hand
  // batch B).
  const login = await publicLoginCaller();
  if (!login) return unauthorizedRefusal();
  const parsed = Params.safeParse(await ctx.params);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const status = await pairCodeStatus(parsed.data.id, login.loginId);
  return NextResponse.json(status, { headers: { 'Cache-Control': CACHE_CONTROL.none } });
}
