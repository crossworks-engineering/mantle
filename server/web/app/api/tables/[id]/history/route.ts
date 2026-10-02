/**
 * /api/tables/[id]/history — a table's history (apps first-class plan,
 * Phase 4): GET lists it newest first (each commit keeps the version it
 * replaced; the owner's own snapshots); POST takes a snapshot of the
 * published table now, with an optional note. Owner only. See
 * packages/content/src/table-snapshots.ts.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { firstIssue } from '@/lib/zod-issue';
import { getTable } from '@/lib/tables';
import {
  TableSnapshotRefusedError,
  createTableSnapshot,
  listTableSnapshots,
} from '@mantle/content/table-snapshots';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  if (!(await getTable(user.id, id))) {
    return NextResponse.json({ error: 'table not found' }, { status: 404 });
  }
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 100);
  const entries = await listTableSnapshots(user.id, id, {
    limit: Number.isFinite(limit) ? limit : 100,
  });
  return NextResponse.json({ entries });
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
    const snapshot = await createTableSnapshot(user.id, id, {
      note: parsed.data.note ?? null,
      actor: 'owner',
    });
    if (!snapshot) return NextResponse.json({ error: 'table not found' }, { status: 404 });
    return NextResponse.json({ snapshot }, { status: 201 });
  } catch (err) {
    if (err instanceof TableSnapshotRefusedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
