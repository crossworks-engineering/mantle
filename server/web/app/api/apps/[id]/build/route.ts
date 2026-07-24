/**
 * /api/apps/[id]/build — bundle the app's draft source with esbuild and stage
 * the artifact for preview. Returns esbuild errors/warnings verbatim so the
 * editor (and the user) can see what failed. A failed build keeps the last good
 * preview.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { runAppBuild } from '@/lib/app-build-run';


export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const outcome = await runAppBuild(user.id, id);
  if (!outcome) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json(outcome);
}
