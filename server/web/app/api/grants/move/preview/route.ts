import { anyLoginCaller } from '@/lib/auth';
import { grantsRoute, MoveBody, previewMove } from '@/lib/grants';
import { wsBody } from '@/lib/workspaces';

/** Who a move would add or take away. */
export async function POST(req: Request) {
  const login = anyLoginCaller();
  return grantsRoute(login, async (caller) => previewMove(caller, await wsBody(req, MoveBody)));
}
