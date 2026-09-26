import { NextResponse } from '@/server/http-compat';
import { assertEditable, commitDraw, commitPage, getMineItem } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import {
  SaveBody,
  SpaceIdParams,
  conflict,
  inMySpace,
  notFound,
  spaceStateResponse,
} from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';

/**
 * POST /api/member/space/:id/save { doc | scene, if_rev?, svg? } : "Save
 * version". Publishes the working copy as the item's saved version (what
 * teammates and a reviewer read) and clears the draft. Same etag contract as
 * the owner's commit routes. Never indexed: a personal item is not announced
 * to the extractor. Frozen while submitted (409 `frozen`).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const body = SaveBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  const { spaceId } = member;
  const id = params.data.id;
  const { doc, scene, svg, if_rev: baseRev } = body.data;
  try {
    const res = await inMySpace(member, async () => {
      const row = await assertEditable(spaceId, id);
      const saved =
        row.type === 'page' && doc
          ? await commitPage(spaceId, id, doc, { baseRev })
          : row.type === 'draw' && scene
            ? await commitDraw(spaceId, id, scene, { baseRev, svg })
            : null;
      if (!saved) return { kind: 'bad' as const };
      if (!saved.ok) return { kind: 'failed' as const, saved };
      return { kind: 'ok' as const, item: await getMineItem(spaceId, id) };
    });
    if (res.kind === 'bad') {
      return NextResponse.json(
        { error: 'Send `doc` for a page or `scene` for a drawing; notes save as they go.' },
        { status: 400 },
      );
    }
    if (res.kind === 'failed')
      return 'conflict' in res.saved ? conflict(res.saved.rev) : notFound();
    return res.item ? NextResponse.json(res.item) : notFound();
  } catch (err) {
    return spaceStateResponse(err);
  }
}
