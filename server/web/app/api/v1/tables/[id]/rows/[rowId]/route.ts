/**
 * Public API v1 (lib/api-v1.ts).
 *
 * PATCH /api/v1/tables/:id/rows/:rowId { cells, tab? } : merge cells into
 *       one row of the table's DRAFT (the `table_row_update` tool); cells
 *       not named stay. POST .../commit publishes.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { runBuiltinForApi } from '@/lib/api-v1-builtin';
import { firstIssue } from '@/lib/zod-issue';

const Params = z.object({ id: z.string().uuid(), rowId: z.string().min(1).max(100) });
const Body = z.object({
  cells: z.record(z.string(), z.unknown()),
  tab: z.string().max(200).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; rowId: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  return runBuiltinForApi(
    'table_row_update',
    {
      table_id: params.data.id,
      row_id: params.data.rowId,
      cells: parsed.data.cells,
      tab: parsed.data.tab,
    },
    user.id,
  );
}
