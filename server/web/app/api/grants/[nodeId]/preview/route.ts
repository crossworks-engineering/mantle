import { grantsRoute, previewGrant } from '@/lib/grants';

/** What adding or removing a workspace would change (?add=&remove=). */
export async function GET(req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = await ctx.params;
  const q = new URL(req.url).searchParams;
  return grantsRoute((caller) => previewGrant(caller, nodeId, q.get('add'), q.get('remove')));
}
