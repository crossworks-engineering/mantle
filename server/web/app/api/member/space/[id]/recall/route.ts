import { NextResponse } from '@/server/http-compat';
import { recallItem } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { inMySpace, SpaceIdParams, spaceStateResponse, withAdminGuard } from '@/lib/member-space';

/**
 * POST /api/member/space/:id/recall : take a submitted item back for
 * correction (submitted -> draft), any time before an admin accepts it. The
 * admin's review queue drops it; edit, then submit again.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const held = await withAdminGuard(member, params.data.id);
  if (held) return held;
  try {
    const item = await inMySpace(member, () => recallItem(member.spaceId, params.data.id));
    return NextResponse.json({ item });
  } catch (err) {
    return spaceStateResponse(err);
  }
}
