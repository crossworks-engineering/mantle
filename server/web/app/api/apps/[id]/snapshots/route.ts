/**
 * /api/apps/[id]/snapshots — an app's history (apps snapshots, Phase 2):
 * GET lists versions and snapshots newest first (no code); POST takes a
 * snapshot (the code and a copy of the database) with an optional note.
 * Owner only. See packages/content/src/app-snapshots.ts.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { getAppRuntime } from '@mantle/content';
import { createAppSnapshot, listAppSnapshots } from '@mantle/content/app-snapshots';
import { readBody } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The ids are uuids: any other names nothing, the params gateway's one
 *  404 before the handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'content' },
  POST: {
    class: 'content',
    item: { param: 'id', need: 'edit' },
  },
});

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if (!(await getAppRuntime(user.id, id))) {
    return NextResponse.json({ error: 'app not found' }, { status: 404 });
  }
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 100);
  const snapshots = await listAppSnapshots(user.id, id, {
    limit: Number.isFinite(limit) ? limit : 100,
  });
  return NextResponse.json({ snapshots });
}

const CreateBody = z.object({ note: z.string().max(500).nullable().optional() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const body = await readBody(req, CreateBody);
  // Over the budget (AppSnapshotBudgetError): 409, reason 'budget', by the
  // one table.
  const snapshot = await createAppSnapshot(user.id, id, {
    note: body.note ?? null,
    actor: 'owner',
  });
  if (!snapshot) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ snapshot }, { status: 201 });
}
