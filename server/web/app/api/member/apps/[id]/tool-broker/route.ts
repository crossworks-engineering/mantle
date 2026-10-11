import { getMemberOr401 } from '@/lib/auth';
import { memberToolBroker } from '@/lib/app-runner';

/**
 * POST /api/member/apps/:id/tool-broker: a member's run of an app calls
 * host.tools.call() (member logins Phase 4b; the team rules are in
 * lib/app-runner.ts).
 *
 * @deprecated Workspaces W7e: POST /api/apps/:id/tool-broker serves every
 * login. Kept this release for an older UI.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const { id } = await ctx.params;
  return memberToolBroker(req, member, id);
}
