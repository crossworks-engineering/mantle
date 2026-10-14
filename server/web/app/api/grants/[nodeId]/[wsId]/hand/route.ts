import { loginCaller } from '@/lib/auth';
import { grantsRoute, handGrant } from '@/lib/grants';

/** "Change here": a folder-derived grant becomes one set on the item. */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ nodeId: string; wsId: string }> },
) {
  const login = loginCaller();
  const { nodeId, wsId } = await ctx.params;
  return grantsRoute(login, (caller) => handGrant(caller, nodeId, wsId));
}
