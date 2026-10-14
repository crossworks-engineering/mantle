import { loginCaller } from '@/lib/auth';
import { grantsRoute, MoveBody, moveItems } from '@/lib/grants';
import { wsBody } from '@/lib/workspaces';

/** Move items to another home workspace, or into a folder. */
export async function POST(req: Request) {
  const login = loginCaller();
  return grantsRoute(login, async (caller) => moveItems(caller, await wsBody(req, MoveBody)));
}
