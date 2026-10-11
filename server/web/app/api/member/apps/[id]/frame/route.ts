import { NextResponse } from '@/server/http-compat';
import { verifyAppFrameTicket } from '@/lib/auth';
import { isMemberFrameTicket, memberFrame } from '@/lib/app-runner';

/**
 * GET /api/member/apps/:id/frame: the sandbox frame document of a member's
 * run of an app (member logins Phase 4b). Auth is the `?t=` member ticket (a
 * sandboxed iframe sends no cookie); PUBLISHED build only.
 *
 * @deprecated Workspaces W7e: GET /api/apps/:id/frame takes a member ticket
 * too (lib/app-runner.ts). Kept this release for an older UI.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = new URL(req.url).searchParams.get('t');
  const ticket = t ? verifyAppFrameTicket(t) : null;
  if (!ticket || !isMemberFrameTicket(ticket, id)) {
    return new NextResponse('frame ticket required', { status: 401 });
  }
  return memberFrame(req, id, ticket);
}
