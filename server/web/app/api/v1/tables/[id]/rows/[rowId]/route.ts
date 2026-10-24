/**
 * Public API v1 (lib/api-v1.ts).
 *
 * PATCH /api/v1/tables/:id/rows/:rowId { cells, tab? } : merge cells into
 *       one row of the table's DRAFT (the `table_row_update` tool); cells
 *       not named stay. POST .../commit publishes.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { assertItemRight } from '@mantle/db';
import { ownerCaller } from '@/lib/auth';
import { runBuiltinForApi } from '@/lib/api-v1-builtin';
import { readBody } from '@/lib/read-body';
import { tableTitle } from '@mantle/content/table-snapshots';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  PATCH: {
    class: 'content',
    item: { none: 'not decided yet: the write names an item no check reads' },
    keyArea: 'tables',
  },
});

const Params = z.object({ id: z.string().uuid(), rowId: z.string().min(1).max(100) });
const Body = z.object({
  cells: z.record(z.string(), z.unknown()),
  tab: z.string().max(200).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; rowId: string }> }) {
  const user = ownerCaller();
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // The table in the key's scope first, then its edit (pre-check removal
  // part 2), as the item gate asked them: one it does not read is the 404
  // of none, one it may not edit the edit check's refusal (403
  // item-workspace, a read-only copy's words), before the tool runs.
  if ((await tableTitle(user.id, params.data.id)) === null) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  await assertItemRight(params.data.id, 'edit');
  const body = await readBody(req, Body, { empty: null });
  return runBuiltinForApi(
    'table_row_update',
    {
      table_id: params.data.id,
      row_id: params.data.rowId,
      cells: body.cells,
      tab: body.tab,
    },
    user.id,
  );
}
