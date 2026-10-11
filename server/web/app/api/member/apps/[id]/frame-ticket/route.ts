import { getMemberOr401 } from '@/lib/auth';
import { memberFrameTicket } from '@/lib/app-runner';

/**
 * POST /api/member/apps/:id/frame-ticket: the seconds-lived ticket the
 * sandbox iframe presents to the frame route (member logins Phase 4b).
 *
 * @deprecated Workspaces W7e: every login runs an app through POST
 * /api/apps/:id/frame-ticket (lib/app-runner.ts, the same rules). Kept this
 * release for an older UI; it answers 410 once the UI pair has moved.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const { id } = await ctx.params;
  return memberFrameTicket(member, id);
}
