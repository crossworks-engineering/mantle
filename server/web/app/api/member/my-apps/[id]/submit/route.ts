import { NextResponse } from '@/server/http-compat';
import { submitSpaceApp } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { memberWriteGate } from '@/lib/member-space';
import { spaceAppErrorResponse, spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

/**
 * POST /api/member/my-apps/:id/submit: send the member's own app to an
 * admin for review (team apps Phase 3). The admin reviews the PUBLISHED
 * version, so unpublished changes refuse (409 `unpublished`), and so does an
 * app with no green build (409 `no-build`). While submitted it is frozen and
 * its data is read only.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const limited = memberWriteGate(member);
  if (limited) return limited;
  const id = spaceAppId((await ctx.params).id);
  if (!id) return spaceAppNotFound();
  try {
    const app = await submitSpaceApp({ loginId: member.loginId, spaceId: member.spaceId }, id);
    return NextResponse.json({ ok: true, app });
  } catch (err) {
    return spaceAppErrorResponse(err);
  }
}
