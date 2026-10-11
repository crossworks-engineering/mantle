import { getMemberOr401 } from '@/lib/auth';
import { memberDbBroker } from '@/lib/app-runner';

/**
 * POST /api/member/apps/:id/db-broker: a member's run of an app calls
 * host.db.query / host.db.exec on the app's own SQLite (member logins Phase
 * 4b; the rules are in lib/app-runner.ts).
 *
 * @deprecated Workspaces W7e: POST /api/apps/:id/db-broker serves every
 * login. Kept this release for an older UI.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const { id } = await ctx.params;
  return memberDbBroker(req, member, id);
}
