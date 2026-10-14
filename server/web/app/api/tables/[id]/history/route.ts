/**
 * /api/tables/[id]/history — a table's history (apps first-class plan,
 * Phase 4): GET lists it newest first (each commit keeps the version it
 * replaced; the owner's own snapshots); POST takes a snapshot of the
 * published table now, with an optional note. Owner only. See
 * packages/content/src/table-snapshots.ts.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import {
  createTableSnapshot,
  listTableSnapshots,
  tableTitle,
} from '@mantle/content/table-snapshots';
import { readBody } from '@/lib/read-body';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if ((await tableTitle(user.id, id)) === null) {
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
  const user = ownerCaller();
  const { id } = await ctx.params;
  const body = await readBody(req, CreateBody);
  // A refused snapshot (TableSnapshotRefusedError) answers 409 by the one
  // table (A10 part 2).
  const snapshot = await createTableSnapshot(user.id, id, {
    note: body.note ?? null,
    actor: 'owner',
  });
  if (!snapshot) return NextResponse.json({ error: 'table not found' }, { status: 404 });
  return NextResponse.json({ snapshot }, { status: 201 });
}
