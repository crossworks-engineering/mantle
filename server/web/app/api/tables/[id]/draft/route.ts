import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { saveTableDraft } from '@/lib/tables';
import type { TableDoc } from '@mantle/content-core/table-model';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  PUT: {
    class: 'content',
    open: 'owner',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

const Body = z.object({
  data: z.record(z.string(), z.unknown()),
  if_rev: z.number().int().nonnegative().optional(),
});

/**
 * Autosave the working grid. Cheap: persists to the draft only — nothing is
 * rendered to other surfaces or indexed. Publishing happens via POST
 * .../commit. `if_rev` is the same etag the op route uses; the response
 * carries the new `draft_rev` so op batches and whole-doc saves interleave
 * without desyncing the client's etag (audit).
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  // Truncation guard (plan §4): a whole-doc autosave past the materialize
  // window is refused loudly (TableTooLargeError, 400), as is a whole-grid save
  // over a workbook (InputError), by the one table (A10 part 2): the op route
  // is the write path at that size.
  const result = await saveTableDraft(user.id, id, parsed.data.data as TableDoc, {
    ...(parsed.data.if_rev !== undefined ? { ifRev: parsed.data.if_rev } : {}),
  });
  if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!result.ok) {
    return NextResponse.json(
      {
        error: 'draft changed since you loaded it — refetch and re-apply',
        current_rev: result.currentRev,
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, draft_rev: result.draftRev });
}
