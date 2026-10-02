/**
 * /api/apps/[id]/snapshots/[sid] — one entry on an app's history: GET (with
 * its code), PATCH `{ note }`, DELETE (a snapshot and its database copy; a
 * version stays, 409). Owner only.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { firstIssue } from '@/lib/zod-issue';
import {
  AppSnapshotRefusedError,
  deleteAppSnapshot,
  getAppSnapshot,
  setAppSnapshotNote,
} from '@mantle/content/app-snapshots';

type Ctx = { params: Promise<{ id: string; sid: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id, sid } = await ctx.params;
  const snap = await getAppSnapshot(user.id, id, sid);
  if (!snap) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const { schemaVersion: _schemaVersion, ...snapshot } = snap;
  return NextResponse.json({ snapshot });
}

const PatchBody = z.object({ note: z.string().max(500).nullable() });

export async function PATCH(req: Request, ctx: Ctx) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id, sid } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  const ok = await setAppSnapshotNote(user.id, id, sid, parsed.data.note);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id, sid } = await ctx.params;
  try {
    const ok = await deleteAppSnapshot(user.id, id, sid);
    if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AppSnapshotRefusedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
