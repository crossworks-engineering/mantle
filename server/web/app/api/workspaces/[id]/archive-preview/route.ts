import { archivePreview, wsRoute } from '@/lib/workspaces';

/** What archiving would do: items homed here (they block it) and items only
 *  shared here (they lose that share). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return wsRoute((caller) => archivePreview(caller, id));
}
