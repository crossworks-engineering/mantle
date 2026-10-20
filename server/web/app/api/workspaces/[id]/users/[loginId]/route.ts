import { anyLoginCaller } from '@/lib/auth';
import { z } from 'zod';
import { removeUser, setModerator, wsBody, wsRoute } from '@/lib/workspaces';

type Ctx = { params: Promise<{ id: string; loginId: string }> };

const PatchBody = z.object({ moderator: z.boolean() });

/** The Moderator tick. Never the last Moderator's. */
export async function PATCH(req: Request, ctx: Ctx) {
  const login = anyLoginCaller();
  const { id, loginId } = await ctx.params;
  return wsRoute(login, async (caller) =>
    setModerator(caller, id, loginId, (await wsBody(req, PatchBody)).moderator),
  );
}

/** Remove a user, or leave (your own id). Never the last Moderator. */
export async function DELETE(_req: Request, ctx: Ctx) {
  const login = anyLoginCaller();
  const { id, loginId } = await ctx.params;
  return wsRoute(login, (caller) => removeUser(caller, id, loginId));
}
