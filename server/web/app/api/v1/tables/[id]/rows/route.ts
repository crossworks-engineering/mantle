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
import { getOwnerOr401 } from '@/lib/auth';
import { runBuiltinForApi } from '@/lib/api-v1-builtin';
import { firstIssue } from '@/lib/zod-issue';

export { GET } from '../../../../tables/[id]/rows/route';

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
  tab: z.string().max(200).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  return runBuiltinForApi(
    'table_rows_add',
    { table_id: params.data.id, rows: parsed.data.rows, tab: parsed.data.tab },
    user.id,
    201,
  );
}
