import { NextResponse } from '@/server/http-compat';
import { submitItem } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { SpaceIdParams, inMySpace, spaceStateResponse } from '@/lib/member-space';

/**
 * POST /api/member/space/:id/submit : send the item's SAVED version to an admin
 * for review (draft or returned -> submitted). Unsaved edits refuse with 409
 * `unsaved-draft`: save a version first. From here the item is FROZEN:
 * nobody edits it until Accept, Return or Recall.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  try {
    const item = await inMySpace(member, () => submitItem(member.spaceId, params.data.id));
    return NextResponse.json({ item });
  } catch (err) {
    return spaceStateResponse(err);
  }
}
