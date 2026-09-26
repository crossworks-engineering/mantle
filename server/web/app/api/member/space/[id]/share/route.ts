import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { SPACE_SHARING } from '@mantle/db';
import { setSharing } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import { SpaceIdParams, inMySpace, spaceStateResponse } from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';

const Body = z.object({ sharing: z.enum(SPACE_SHARING) });

/**
 * POST /api/member/space/:id/share { sharing: 'private' | 'team' } : who may
 * read the item. Team = every member and admin reads its saved version; only
 * the author edits. Members never set client or public, and never make links.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  try {
    const item = await inMySpace(member, () =>
      setSharing(member.spaceId, params.data.id, body.data.sharing),
    );
    return NextResponse.json({ item });
  } catch (err) {
    return spaceStateResponse(err);
  }
}
