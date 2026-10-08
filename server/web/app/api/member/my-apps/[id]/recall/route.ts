import { NextResponse } from '@/server/http-compat';
import { recallSpaceApp } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { memberWriteGate } from '@/lib/member-space';
import { spaceAppErrorResponse, spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

/**
 * POST /api/member/my-apps/:id/recall: take the member's own submitted app
 * back from review, to a draft they may change again (team apps Phase 3).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const limited = memberWriteGate(member);
  if (limited) return limited;
  const id = spaceAppId((await ctx.params).id);
  if (!id) return spaceAppNotFound();
  try {
    const app = await recallSpaceApp({ loginId: member.loginId, spaceId: member.spaceId }, id);
    return NextResponse.json({ ok: true, app });
  } catch (err) {
    return spaceAppErrorResponse(err);
  }
}
