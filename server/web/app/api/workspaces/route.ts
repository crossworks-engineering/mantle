import { anyLoginCaller } from '@/lib/auth';
import { z } from 'zod';
import { createWorkspace, listWorkspaces, wsBody, wsRoute } from '@/lib/workspaces';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any' },
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: "the login's own things, not an item" },
  },
});

/**
 * Workspaces (docs/workspaces.md; lib/workspaces.ts holds the rules).
 * GET: an Admin user gets every workspace, any other login the live ones it
 * is a user of. POST: any login makes one and is its only user, a Moderator.
 * Any login reaches these (the policy above: open: 'any'); each rule is in
 * the query.
 */
export async function GET() {
  const login = anyLoginCaller();
  return wsRoute(login, (caller) => listWorkspaces(caller));
}

const CreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
});

export async function POST(req: Request) {
  const login = anyLoginCaller();
  return wsRoute(
    login,
    async (caller) => createWorkspace(caller, await wsBody(req, CreateBody)),
    201,
  );
}
