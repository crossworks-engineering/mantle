/**
 * /api/apps/[id]/publish — promote the draft (source + build) to the live app.
 * Refuses (409) if the draft has no successful build.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { publishApp, NoGreenBuildError } from '@mantle/content';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  try {
    const app = await publishApp(user.id, id);
    if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
    return NextResponse.json({ app });
  } catch (err) {
    if (err instanceof NoGreenBuildError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
