/**
 * Public API v1 (lib/api-v1.ts).
 *
 * PATCH /api/v1/tables/:id/rows/:rowId { cells, tab? } : merge cells into
 *       one row of the table's DRAFT (the `table_row_update` tool); cells
 *       not named stay. POST .../commit publishes.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { runBuiltinForApi } from '@/lib/api-v1-builtin';
import { readBody } from '@/lib/read-body';

const Params = z.object({ id: z.string().uuid(), rowId: z.string().min(1).max(100) });
const Body = z.object({
  cells: z.record(z.string(), z.unknown()),
  tab: z.string().max(200).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; rowId: string }> }) {
  const user = ownerCaller();
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'not found' }, { status: 404 });
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
