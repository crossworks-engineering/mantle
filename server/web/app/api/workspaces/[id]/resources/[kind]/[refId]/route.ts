import { z } from 'zod';
import { patchResource, removeResource, wsBody, wsRoute } from '@/lib/workspaces';

type Ctx = { params: Promise<{ id: string; kind: string; refId: string }> };

const PatchBody = z.object({ write: z.boolean() });

/** A connector's Write tick. */
export async function PATCH(req: Request, ctx: Ctx) {
  const { id, kind, refId } = await ctx.params;
  return wsRoute(async (caller) =>
    patchResource(caller, id, kind, refId, (await wsBody(req, PatchBody)).write),
  );
}

/** Detach the assistant (refused once it has history) or a connector. */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id, kind, refId } = await ctx.params;
  return wsRoute((caller) => removeResource(caller, id, kind, refId));
}
