import { NextResponse } from '@/server/http-compat';
import {
  assertEditable,
  saveMineDraw,
  saveMinePage,
  getMineItem,
  saveMineTable,
} from '@mantle/content';
import type { TableDoc } from '@mantle/content-core/table-model';
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
 * POST /api/member/space/:id/save { doc | scene | table?, if_rev?, svg? } :
 * "Save version". A table saves its server draft (or a whole `table` sent
 * here). Publishes the working copy as the item's saved version (what
 * teammates and a reviewer read) and clears the draft. Same etag contract as
 * the owner's commit routes. A page may embed or link only the member's own
 * items and Library items (409 `embed` with the refused `ids`). Never
 * indexed: a personal item is not announced
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
  const { doc, scene, table, svg, if_rev: baseRev } = body.data;
  try {
    const res = await inMySpace(member, async () => {
      const row = await assertEditable(spaceId, id);
      if (row.type === 'table') {
        const item = await saveMineTable(spaceId, id, table as unknown as TableDoc | undefined);
        return item ? { kind: 'ok' as const, item } : { kind: 'gone' as const };
      }
      const saved =
        row.type === 'page' && doc
          ? await saveMinePage(spaceId, id, doc, { baseRev })
          : row.type === 'draw' && scene
            ? await saveMineDraw(spaceId, id, scene, { baseRev, svg })
            : null;
      if (!saved) return { kind: 'bad' as const };
      if (!saved.ok) return { kind: 'failed' as const, saved };
      return { kind: 'ok' as const, item: await getMineItem(spaceId, id) };
    });
    if (res.kind === 'gone') return notFound();
    if (res.kind === 'bad') {
      return NextResponse.json(
        {
          error: 'Send `doc` for a page or `scene` for a drawing; notes and files save as they go.',
        },
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
