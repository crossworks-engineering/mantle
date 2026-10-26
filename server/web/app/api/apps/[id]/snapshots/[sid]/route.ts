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
import { assertItemRight } from '@mantle/db';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The ids are uuids: any other names nothing, the params gateway's one
 *  404 before the handler (lib/route-params.ts; the item gate answered it
 *  until the pre-check removal part 2). */
export const routeParams = { id: 'uuid', sid: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'content' },
  PATCH: {
    class: 'content',
    item: { param: 'id', need: 'edit' },
  },
  DELETE: {
    class: 'content',
    item: { param: 'id', need: 'edit' },
  },
});

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
  // The caller's edit of the app first (the pre-check removal part 2: the
  // HTTP gate asked it): an app the scope does not read is the mapper's
  // 404, as an id no row has; one it may not edit the 403 item-workspace (a
  // read-only copy's words); before anything is read, built or staged.
  await assertItemRight(id, 'edit');
  const body = await readBody(req, PatchBody);
  const ok = await setAppSnapshotNote(user.id, id, sid, body.note);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const user = ownerCaller();
  const { id, sid } = await ctx.params;
  // deleteAppSnapshot asks the caller's edit of the app first (the one
  // item-rights gateway): an app the scope does not read is the mapper's
  // 404, as an id no row has; one it may not edit the 403 item-workspace.
  // A version refuses (AppSnapshotRefusedError): 409 by the one table (A10
  // part 2).
  const ok = await deleteAppSnapshot(user.id, id, sid);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
