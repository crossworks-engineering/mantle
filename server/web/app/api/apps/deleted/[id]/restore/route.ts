/**
 * POST /api/apps/deleted/[id]/restore — bring a deleted app back with its id,
 * code, name, look and data (apps first-class plan, Phase 3). It returns
 * admin-only in Unsorted; its sharing does not come back. 404 when it is not
 * in the trash; 409 when the app is not deleted. Owner only.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { restoreDeletedApp } from '@mantle/content/app-trash';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // AppTrashRefusedError answers 409 by the one table (A10 part 2).
  const app = await restoreDeletedApp(user.id, id, { actor: 'owner' });
  if (!app) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ app });
}
