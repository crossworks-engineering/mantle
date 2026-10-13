import { z } from 'zod';
import { LookColorBody, LookIconBody } from '@/lib/look-body';
import { getWorkspace, patchWorkspace, wsBody, wsRoute } from '@/lib/workspaces';

type Ctx = { params: Promise<{ id: string }> };

/** One workspace's screen: users, resources, whether its assistant has
 *  history. 404 unless the caller is a user of it or an Admin user. */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return wsRoute((caller) => getWorkspace(caller, id));
}

const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    // The folder's own validators (one palette, one icon vocabulary).
    color: LookColorBody.nullable().optional(),
    icon: LookIconBody.optional(),
    contactNodeId: z.string().uuid().nullable().optional(),
    assistantId: z.string().uuid().nullable().optional(),
    landingAppId: z.string().uuid().nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update.');

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return wsRoute(async (caller) => patchWorkspace(caller, id, await wsBody(req, PatchBody)));
}
