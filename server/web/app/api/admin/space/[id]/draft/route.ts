import { NextResponse } from '@/server/http-compat';
import {
  applyTableOps,
  assertEditable,
  assertSpaceStorage,
  saveDraft,
  saveDrawDraft,
  saveTableDraft,
} from '@mantle/content';
import type { TableOp } from '@mantle/tabledb';
import type { TableDoc } from '@mantle/content-core/table-model';
import { getAdminSpaceOr401, inAdminSpace } from '@/lib/admin-space';
import {
  DraftBody,
  SpaceIdParams,
  conflict,
  notFound,
  spaceStateResponse,
} from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';

/**
 * PUT /api/admin/space/:id/draft { doc | scene | table | ops, if_rev? } :
 * autosave the calling admin's working copy of one of their private items,
 * as PUT /api/member/space/:id/draft (same body, etag and answers). Nothing
 * is published or indexed. A table draft is refused once the space's
 * storage is full (409 `quota`).
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await getAdminSpaceOr401();
  if (caller instanceof Response) return caller;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const bodyBytes = Number(req.headers.get('content-length')) || 0;
  const body = DraftBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  const { spaceId } = caller;
  const id = params.data.id;
  const { doc, scene, table, ops, if_rev: baseRev } = body.data;
  const ifRev = baseRev !== undefined ? { ifRev: baseRev } : {};
  // The registry lock found no row: the item was submitted (or deleted)
  // after the state check above. Ask again so a frozen item answers 409
  // `frozen` instead of a bare 404.
  const lockLost = () => assertEditable(spaceId, id);
  try {
    const res = await inAdminSpace(caller, async () => {
      const row = await assertEditable(spaceId, id);
      if (row.type === 'page' && doc) return saveDraft(spaceId, id, doc, { baseRev });
      if (row.type === 'draw' && scene) return saveDrawDraft(spaceId, id, scene, { baseRev });
      // A table draft grows on disk: refuse it once the space is full (a
      // request adds at most its own size, so the overshoot is bounded).
      if (row.type === 'table' && (ops || table)) await assertSpaceStorage(spaceId, bodyBytes);
      if (row.type === 'table' && ops) {
        const r = await applyTableOps(spaceId, id, ops as unknown as TableOp[], ifRev);
        if (!r) {
          await lockLost();
          return { ok: false as const };
        }
        return r.ok
          ? { ok: true as const, rev: r.draftRev, createdIds: r.createdIds }
          : { ok: false as const, conflict: true as const, rev: r.currentRev };
      }
      if (row.type === 'table' && table) {
        const r = await saveTableDraft(spaceId, id, table as unknown as TableDoc, ifRev);
        if (!r) {
          await lockLost();
          return { ok: false as const };
        }
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
