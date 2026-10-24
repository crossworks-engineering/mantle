import { anyLoginCaller } from '@/lib/auth';
import { grantsRoute, MoveBody, previewMove } from '@/lib/grants';
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

/** Who a move would add or take away. */
export async function POST(req: Request) {
  const login = anyLoginCaller();
  return grantsRoute(login, async (caller) => previewMove(caller, await wsBody(req, MoveBody)));
}
