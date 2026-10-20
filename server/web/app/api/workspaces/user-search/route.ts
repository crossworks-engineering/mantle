import { anyLoginCaller } from '@/lib/auth';
import { searchUsers, wsRoute } from '@/lib/workspaces';

/** Logins by email or name, for adding them to a workspace (plan 18.13
 *  Q3). A Moderator of any workspace or an Admin user; an Admin user pages
 *  with `offset` (50 a page). lib/workspaces.ts. */
export async function GET(req: Request) {
  const login = anyLoginCaller();
  const params = new URL(req.url).searchParams;
  const q = params.get('q') ?? '';
  const raw = params.get('offset');
  const offset = raw === null || raw === '' ? 0 : /^\d{1,9}$/.test(raw) ? Number(raw) : -1;
  return wsRoute(login, (caller) => searchUsers(caller, q.slice(0, 200), offset));
}
