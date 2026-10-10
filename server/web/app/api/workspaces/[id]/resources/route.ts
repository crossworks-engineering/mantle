import { z } from 'zod';
import { addResource, wsBody, wsRoute } from '@/lib/workspaces';

const AddBody = z.object({
  kind: z.enum(['assistant', 'connector']),
  id: z.string().trim().min(1).max(200),
  write: z.boolean().optional(),
});

/** Attach the assistant or a connector (an Admin user). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return wsRoute(async (caller) => addResource(caller, id, await wsBody(req, AddBody)));
}
