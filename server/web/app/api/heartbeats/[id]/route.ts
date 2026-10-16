import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { deleteHeartbeat, getHeartbeat, updateHeartbeat } from '@/lib/heartbeats';
import { toolMakerFor } from '@/lib/tools';
import { UpdateHeartbeatBody, toUpdateInput } from '@/lib/heartbeat-schema';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

/** One owner-scoped heartbeat (summary), or 404. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const heartbeat = await getHeartbeat(user.id, id, toolMakerFor(user));
  if (!heartbeat) return NextResponse.json({ error: 'Heartbeat not found.' }, { status: 404 });
  return NextResponse.json({ heartbeat });
}

/** Partial update — also the pause/resume path (`{ status }`). Only the keys
 *  present in the body are written; a status-only PATCH leaves config intact. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const parsed = UpdateHeartbeatBody.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstIssue(parsed.error, 'Invalid input.') },
      { status: 400 },
    );
  }
  // A schedule that is not valid (InputError) answers 400 by the one table
  // (A10 part 2); a fault the opaque 500.
  const heartbeat = await updateHeartbeat(user.id, id, toUpdateInput(parsed.data), user.actor.id);
  if (!heartbeat) return NextResponse.json({ error: 'Heartbeat not found.' }, { status: 404 });
  return NextResponse.json({ heartbeat });
}

/** Delete a heartbeat (its fire history cascades). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const ok = await deleteHeartbeat(user.id, id);
  if (!ok) return NextResponse.json({ error: 'Heartbeat not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
