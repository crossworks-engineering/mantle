import { NextResponse } from '@/server/http-compat';
import { verifyAppFrameTicket } from '@/lib/auth';
import { isMemberFrameTicket } from '@/lib/app-runner';
import { MEMBER_ROUTES_GONE_MESSAGE, goneResponse } from '@/lib/gone';

/**
 * GET /api/member/apps/:id/frame
 * Removed in workspaces W8d (deprecated since W7e): GET /api/apps/:id/frame
 * takes a member ticket (lib/app-runner.ts). The old guard runs first (the
 * `?t=` member ticket: a sandboxed iframe sends no cookie, so no ticket is
 * 401 as before), then 410 `{ error, code: 'gone' }`.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = new URL(req.url).searchParams.get('t');
  const ticket = t ? verifyAppFrameTicket(t) : null;
  if (!ticket || !isMemberFrameTicket(ticket, id)) {
    return new NextResponse('frame ticket required', { status: 401 });
  }
  return goneResponse(MEMBER_ROUTES_GONE_MESSAGE);
}
