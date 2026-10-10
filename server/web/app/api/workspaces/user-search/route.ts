import { searchUsers, wsRoute } from '@/lib/workspaces';

/** Logins by email or name, for adding them to a workspace (plan 18.13
 *  Q3). A Moderator of any workspace or an Admin user; lib/workspaces.ts. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('q') ?? '';
  return wsRoute((caller) => searchUsers(caller, q.slice(0, 200)));
}
