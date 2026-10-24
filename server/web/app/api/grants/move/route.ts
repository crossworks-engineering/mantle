import { anyLoginCaller } from '@/lib/auth';
import { grantsRoute, MoveBody, moveItems } from '@/lib/grants';
import { wsBody } from '@/lib/workspaces';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

/** Move items to another home workspace, or into a folder. */
export async function POST(req: Request) {
  const login = anyLoginCaller();
  return grantsRoute(login, async (caller) => moveItems(caller, await wsBody(req, MoveBody)));
}
