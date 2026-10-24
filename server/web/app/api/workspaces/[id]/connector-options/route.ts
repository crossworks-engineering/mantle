import { anyLoginCaller } from '@/lib/auth';
import { connectorOptions, wsRoute } from '@/lib/workspaces';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any' },
});

/** The connectors this workspace may hold, MCP and HTTP API alike, each
 *  with whether it holds it already: the attach's own rule and gate (an
 *  Admin user with the connectors area). lib/workspaces.ts. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  return wsRoute(login, (caller) => connectorOptions(caller, id));
}
