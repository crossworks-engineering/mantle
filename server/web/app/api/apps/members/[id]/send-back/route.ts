/**
 * POST /api/apps/members/:id/send-back: send a submitted member app back to
 * its author. It returns as `returned`: editable again, and the author may
 * submit it again. No note: review flows carry no messages (2026-10-09).
 * 409 when it is not waiting for approval.
 */
import { NextResponse } from '@/server/http-compat';
import { sendBackSpaceApp } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';
import { reviewer } from '@/lib/member-review';
import { spaceAppErrorResponse, spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const id = spaceAppId((await ctx.params).id);
  if (!id) return spaceAppNotFound();
  try {
    await sendBackSpaceApp(id, reviewer(user));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return spaceAppErrorResponse(err);
  }
}
