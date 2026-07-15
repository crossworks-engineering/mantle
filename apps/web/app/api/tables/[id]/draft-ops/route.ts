import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { applyTableOps } from '@/lib/tables';
import type { TableOp } from '@mantle/tabledb';

/**
 * Apply an op batch to the table's DRAFT (P3). The batch is atomic on the
 * server (all ops or none, under the registry lock); `if_rev` is the etag
 * from the last read/apply — a stale value gets 409 + the current rev so the
 * client refetches instead of silently clobbering newer (e.g. agent) edits.
 */
const Op = z.object({ op: z.string() }).passthrough();
const Body = z.object({
  ops: z.array(Op).min(1).max(500),
  if_rev: z.number().int().nonnegative().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input: expected { ops: [...], if_rev? }' }, { status: 400 });
  }
  try {
    const result = await applyTableOps(user.id, id, parsed.data.ops as unknown as TableOp[], {
      ...(parsed.data.if_rev !== undefined ? { ifRev: parsed.data.if_rev } : {}),
    });
    if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if (!result.ok) {
      return NextResponse.json(
        { error: 'draft changed since you loaded it — refetch and re-apply', current_rev: result.currentRev },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, draft_rev: result.draftRev, created_ids: result.createdIds });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'op batch failed' }, { status: 400 });
  }
}
