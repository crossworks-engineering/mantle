import { NextResponse } from '@/server/http-compat';
import {
  assertEditable,
  saveMineDraw,
  saveMinePage,
  getMineItem,
  saveMineTable,
} from '@mantle/content';
import type { TableDoc } from '@mantle/content-core/table-model';
import { adminWriter, getAdminSpaceOr401, inAdminSpace } from '@/lib/admin-space';
import { readJsonNoNul } from '@/lib/strip-nul';
import {
  SaveBody,
  SpaceIdParams,
  conflict,
  notFound,
  spaceStateResponse,
} from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';

/**
 * POST /api/admin/space/:id/save { doc | scene | table?, if_rev?, svg? } :
 * "Save version" of one of the calling admin's private items, as
 * POST /api/member/space/:id/save (same body, etag and answers). The embed
 * rule is the admin's (Phase 7): their own items and the brain's items at
 * ANY level, admin included; never another login's personal item (409
 * `embed` with the refused `ids`). Never indexed: a private item is not
 * announced to the extractor until Accept.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await getAdminSpaceOr401();
  if (caller instanceof Response) return caller;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const body = SaveBody.safeParse(await readJsonNoNul(req));
  if (!body.success) return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  const { spaceId } = caller;
  const writer = adminWriter(caller);
  const id = params.data.id;
  const { doc, scene, table, svg, if_rev: baseRev } = body.data;
  try {
    const res = await inAdminSpace(caller, async () => {
      const row = await assertEditable(spaceId, id);
      if (row.type === 'table') {
        const item = await saveMineTable(
          spaceId,
          id,
          table as unknown as TableDoc | undefined,
          writer,
        );
        return item ? { kind: 'ok' as const, item } : { kind: 'gone' as const };
      }
      const saved =
        row.type === 'page' && doc
          ? await saveMinePage(spaceId, id, doc, { baseRev, ...writer })
          : row.type === 'draw' && scene
            ? await saveMineDraw(spaceId, id, scene, { baseRev, svg, ...writer })
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
