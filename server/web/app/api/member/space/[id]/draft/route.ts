import { NextResponse } from '@/server/http-compat';
import { assertEditable, saveDraft, saveDrawDraft } from '@mantle/content';
import { getMemberOr401 } from '@/lib/auth';
import {
  DraftBody,
  SpaceIdParams,
  conflict,
  inMySpace,
  notFound,
  spaceStateResponse,
} from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';

/**
 * PUT /api/member/space/:id/draft { doc | scene, if_rev? } : autosave the
 * member's working copy of a page (`doc`) or drawing (`scene`). Same contract
 * as the owner's draft routes: `if_rev` is the draft etag, success answers
 * `{ ok, draft_rev }`, a stale etag 409 with `current_rev`. Nothing is
 * published or indexed; the saved version (what teammates and a reviewer
 * see) changes only on Save version. Frozen while submitted (409 `frozen`).
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberOr401();
  if (member instanceof Response) return member;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const body = DraftBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  const { spaceId } = member;
  const id = params.data.id;
  const { doc, scene, if_rev: baseRev } = body.data;
  try {
    const res = await inMySpace(member, async () => {
      const row = await assertEditable(spaceId, id);
      if (row.type === 'page' && doc) return saveDraft(spaceId, id, doc, { baseRev });
      if (row.type === 'draw' && scene) return saveDrawDraft(spaceId, id, scene, { baseRev });
      return null;
    });
    if (!res) {
      return NextResponse.json(
        { error: 'Send `doc` for a page or `scene` for a drawing; notes have no draft.' },
        { status: 400 },
      );
    }
    if (res.ok) return NextResponse.json({ ok: true, draft_rev: res.rev });
    return 'conflict' in res ? conflict(res.rev) : notFound();
  } catch (err) {
    return spaceStateResponse(err);
  }
}
