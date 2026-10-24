import { anyLoginCaller } from '@/lib/auth';
import { grantsRoute, previewGrant } from '@/lib/grants';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any' },
});

/** What adding or removing a workspace would change (?add=&remove=). */
export async function GET(req: Request, ctx: { params: Promise<{ nodeId: string }> }) {
  const login = anyLoginCaller();
  const { nodeId } = await ctx.params;
  const q = new URL(req.url).searchParams;
  return grantsRoute(login, (caller) =>
    previewGrant(caller, nodeId, q.get('add'), q.get('remove')),
  );
}
