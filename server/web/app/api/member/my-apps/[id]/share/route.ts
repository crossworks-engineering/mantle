import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { setSpaceAppSharing } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { memberWriteGate } from '@/lib/member-space';
import { spaceAppErrorResponse, spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

const Body = z.object({ sharing: z.enum(['private', 'team']) });

/**
 * POST /api/member/my-apps/:id/share { sharing: 'private' | 'team' }: who
 * runs the member's own app (team apps Phase 3). Team = every member runs
 * its published version at team rules and writes its data; no approval and
 * no level change (it stays in the author's space). Only the author.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const limited = memberWriteGate(member);
  if (limited) return limited;
  const id = spaceAppId((await ctx.params).id);
  if (!id) return spaceAppNotFound();
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json(
      { ok: false, error: "sharing must be 'private' or 'team'" },
      { status: 400 },
    );
  }
  try {
    const app = await setSpaceAppSharing(
      { loginId: member.loginId, spaceId: member.spaceId },
      id,
      body.data.sharing,
    );
    return NextResponse.json({ ok: true, app });
  } catch (err) {
    return spaceAppErrorResponse(err);
  }
}
