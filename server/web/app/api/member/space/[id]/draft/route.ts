import { NextResponse } from '@/server/http-compat';
import {
  applyTableOps,
  assertEditable,
  saveDraft,
  saveDrawDraft,
  saveTableDraft,
} from '@mantle/content';
import type { TableOp } from '@mantle/tabledb';
import type { TableDoc } from '@mantle/content-core/table-model';
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
 * PUT /api/member/space/:id/draft { doc | scene | table | ops, if_rev? } :
 * autosave the member's working copy of a page (`doc`), a drawing (`scene`)
 * or a table (a whole `table` document, or an `ops` batch applied atomically
 * to the draft workbook; answers `created_ids` too). Same contract
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
  const { doc, scene, table, ops, if_rev: baseRev } = body.data;
  const ifRev = baseRev !== undefined ? { ifRev: baseRev } : {};
  try {
    const res = await inMySpace(member, async () => {
      const row = await assertEditable(spaceId, id);
      if (row.type === 'page' && doc) return saveDraft(spaceId, id, doc, { baseRev });
      if (row.type === 'draw' && scene) return saveDrawDraft(spaceId, id, scene, { baseRev });
      if (row.type === 'table' && ops) {
        const r = await applyTableOps(spaceId, id, ops as unknown as TableOp[], ifRev);
        if (!r) return { ok: false as const };
        return r.ok
          ? { ok: true as const, rev: r.draftRev, createdIds: r.createdIds }
          : { ok: false as const, conflict: true as const, rev: r.currentRev };
      }
      if (row.type === 'table' && table) {
        const r = await saveTableDraft(spaceId, id, table as unknown as TableDoc, ifRev);
        if (!r) return { ok: false as const };
        return r.ok
          ? { ok: true as const, rev: r.draftRev }
          : { ok: false as const, conflict: true as const, rev: r.currentRev };
      }
      return null;
    });
    if (!res) {
      return NextResponse.json(
        {
          error:
            'Send `doc` for a page, `scene` for a drawing, `table` or `ops` for a table; notes and files have no draft.',
        },
        { status: 400 },
      );
    }
    if (res.ok) {
      return NextResponse.json({
        ok: true,
        draft_rev: res.rev,
        ...('createdIds' in res ? { created_ids: res.createdIds } : {}),
      });
    }
    return 'conflict' in res ? conflict(res.rev) : notFound();
  } catch (err) {
    return spaceStateResponse(err);
  }
}
