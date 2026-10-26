/**
 * Public API v1 (lib/api-v1.ts).
 *
 * GET  /api/v1/tables/:id/rows : the same handler as /api/tables/:id/rows.
 * POST /api/v1/tables/:id/rows { rows, tab? } : append up to 200 rows to the
 *      table's DRAFT in one batch (the `table_rows_add` tool). Each row is an
 *      object of cells keyed by column name. POST .../commit publishes.
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
  GET: { class: 'content', keyArea: 'tables', aliasOf: 'GET /api/tables/:id/rows' },
  POST: {
    class: 'content',
    item: { param: 'id', need: 'edit' },
    keyArea: 'tables',
  },
});

export { GET, routeParams } from '../../../../tables/[id]/rows/route';

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
  tab: z.string().max(200).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
    'table_rows_add',
    { table_id: params.data.id, rows: body.rows, tab: body.tab },
    user.id,
    201,
  );
}
