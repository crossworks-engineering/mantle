import { anyLoginCaller } from '@/lib/auth';
import { grantsRoute, MoveBody, previewMove } from '@/lib/grants';
import { wsBody } from '@/lib/workspaces';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: {
      none: "a grant change: its rule asks two workspaces (the item's home and the grant's), no one right of the item; the grants panel's definers decide it",
    },
  },
});

/** Who a move would add or take away. */
export async function POST(req: Request) {
  const login = anyLoginCaller();
  return grantsRoute(login, async (caller) => previewMove(caller, await wsBody(req, MoveBody)));
}
