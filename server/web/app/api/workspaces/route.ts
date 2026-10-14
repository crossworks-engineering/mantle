import { loginCaller } from '@/lib/auth';
import { z } from 'zod';
import { createWorkspace, listWorkspaces, wsBody, wsRoute } from '@/lib/workspaces';

/**
 * Workspaces (plan page 4887b8e7, W5a; lib/workspaces.ts holds the rules).
 * GET: an Admin user gets every workspace, any other login the live ones it
 * is a user of. POST: any login makes one and is its only user, a Moderator.
 * Any login reaches these (lib/auth/any-login-routes.ts); each rule is in
 * the query.
 */
export async function GET() {
  const login = loginCaller();
  return wsRoute(login, (caller) => listWorkspaces(caller));
}

const CreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
});

export async function POST(req: Request) {
  const login = loginCaller();
  return wsRoute(
    login,
    async (caller) => createWorkspace(caller, await wsBody(req, CreateBody)),
    201,
  );
}
