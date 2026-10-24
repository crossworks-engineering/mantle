import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { parseWsFilter } from '@/lib/list-workspaces';
import { landingName, workspaceHome } from '@/lib/landing';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
});

/**
 * GET /api/home?ws=<id>: the landing page of the login's current workspace
 * (task d78e7bde), for every login, Admin users and members alike. Without
 * `ws` it is "All my workspaces": the Built-in home over every workspace of
 * the login. With it: that workspace's home app when it names one the login
 * may run, and the Built-in home's data kept to what that workspace reads.
 * A workspace the login may not name is 404 (parseWsFilter). The shape is
 * WorkspaceHomeData (lib/landing.ts).
 *
 * A content read: the guard runs it in the login's request scope
 * (route-scope.ts), and a member reaches it through MEMBER_OPEN_READS.
 */
export async function GET(req: Request) {
  const user = ownerCaller();
  const ws = await parseWsFilter(req, user.id, user.actor.id);
  if (ws instanceof Response) return ws;
  return NextResponse.json(
    await workspaceHome(
      { anchorId: user.id, loginId: user.actor.id, name: landingName(user.actor) },
      ws,
    ),
  );
}
