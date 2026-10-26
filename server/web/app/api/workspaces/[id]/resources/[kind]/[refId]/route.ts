import { anyLoginCaller } from '@/lib/auth';
import { z } from 'zod';
import { patchResource, removeResource, wsBody, wsRoute } from '@/lib/workspaces';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PATCH: {
    class: 'self',
    scope: null,
    open: 'any',
    item: {
      none: 'a workspace’s assistant or connector, no workspace item kind: its definers decide by the workspace seats',
      param: 'refId',
    },
  },
  DELETE: {
    class: 'self',
    scope: null,
    open: 'any',
    item: {
      none: 'a workspace’s assistant or connector, no workspace item kind: its definers decide by the workspace seats',
      param: 'refId',
    },
  },
});

type Ctx = { params: Promise<{ id: string; kind: string; refId: string }> };

const PatchBody = z.object({ write: z.boolean() });

/** A connector's Write tick. */
export async function PATCH(req: Request, ctx: Ctx) {
  const login = anyLoginCaller();
  const { id, kind, refId } = await ctx.params;
  return wsRoute(login, async (caller) =>
    patchResource(caller, id, kind, refId, (await wsBody(req, PatchBody)).write),
  );
}

/** Detach the assistant (refused once it has history) or a connector. */
export async function DELETE(_req: Request, ctx: Ctx) {
  const login = anyLoginCaller();
  const { id, kind, refId } = await ctx.params;
  return wsRoute(login, (caller) => removeResource(caller, id, kind, refId));
}
