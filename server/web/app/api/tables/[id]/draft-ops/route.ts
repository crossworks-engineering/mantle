import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { applyTableOps } from '@/lib/tables';
import type { TableOp } from '@mantle/tabledb';
import { TableOpsSchema } from '@/lib/table-ops-schema';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'edit' },
  },
});

/**
 * Apply an op batch to the table's DRAFT (P3). The batch is atomic on the
 * server (all ops or none, under the registry lock); `if_rev` is the etag
 * from the last read/apply — a stale value gets 409 + the current rev so the
 * client refetches instead of silently clobbering newer (e.g. agent) edits.
 *
 * The op schema lives in lib/table-ops-schema.ts (shared with the member
 * routes).
 */
const Body = z.object({
  ops: TableOpsSchema,
  if_rev: z.number().int().nonnegative().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid input: expected { ops: [...], if_rev? }' },
      { status: 400 },
    );
  }
  // A refused op (InputError: no such tab, a column already there) answers
  // 400, an app table 409, by the one table; a fault the opaque 500.
  const result = await applyTableOps(user.id, id, parsed.data.ops as unknown as TableOp[], {
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
  return NextResponse.json({
    ok: true,
    draft_rev: result.draftRev,
    created_ids: result.createdIds,
  });
}
