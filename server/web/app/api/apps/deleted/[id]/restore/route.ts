/**
 * POST /api/apps/deleted/[id]/restore — bring a deleted app back with its id,
 * code, name, look and data (apps first-class plan, Phase 3). It returns
 * admin-only in Unsorted; its sharing does not come back. 404 when it is not
 * in the trash; 409 when the app is not deleted. Owner only.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { AppTrashRefusedError, restoreDeletedApp } from '@mantle/content/app-trash';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  try {
    const app = await restoreDeletedApp(user.id, id, { actor: 'owner' });
    if (!app) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ app });
  } catch (err) {
    if (err instanceof AppTrashRefusedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
