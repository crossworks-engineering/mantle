/**
 * /api/apps/[id]/snapshots/[sid] — one entry on an app's history: GET (with
 * its code), PATCH `{ note }`, DELETE (a snapshot and its database copy; a
 * version stays, 409). Owner only.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import {
  deleteAppSnapshot,
  getAppSnapshot,
  setAppSnapshotNote,
} from '@mantle/content/app-snapshots';
import { readBody } from '@/lib/read-body';

type Ctx = { params: Promise<{ id: string; sid: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const user = ownerCaller();
  const { id, sid } = await ctx.params;
  const snap = await getAppSnapshot(user.id, id, sid);
  if (!snap) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const { schemaVersion: _schemaVersion, ...snapshot } = snap;
  return NextResponse.json({ snapshot });
}

const PatchBody = z.object({ note: z.string().max(500).nullable() });

export async function PATCH(req: Request, ctx: Ctx) {
  const user = ownerCaller();
  const { id, sid } = await ctx.params;
  const body = await readBody(req, PatchBody);
  const ok = await setAppSnapshotNote(user.id, id, sid, body.note);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const user = ownerCaller();
  const { id, sid } = await ctx.params;
  // A version refuses (AppSnapshotRefusedError): 409 by the one table (A10
  // part 2).
  const ok = await deleteAppSnapshot(user.id, id, sid);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
