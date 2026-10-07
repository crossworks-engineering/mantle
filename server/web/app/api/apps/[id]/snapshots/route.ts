/**
 * /api/apps/[id]/snapshots — an app's history (apps snapshots, Phase 2):
 * GET lists versions and snapshots newest first (no code); POST takes a
 * snapshot (the code and a copy of the database) with an optional note.
 * Owner only. See packages/content/src/app-snapshots.ts.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { firstIssue } from '@/lib/zod-issue';
import { getAppRuntime } from '@mantle/content';
import {
  AppSnapshotBudgetError,
  createAppSnapshot,
  listAppSnapshots,
} from '@mantle/content/app-snapshots';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  try {
    const snapshot = await createAppSnapshot(user.id, id, {
      note: parsed.data.note ?? null,
      actor: 'owner',
    });
    if (!snapshot) return NextResponse.json({ error: 'app not found' }, { status: 404 });
    return NextResponse.json({ snapshot }, { status: 201 });
  } catch (err) {
    if (err instanceof AppSnapshotBudgetError) {
      return NextResponse.json({ error: err.message, reason: 'budget' }, { status: 409 });
    }
    throw err;
  }
}
