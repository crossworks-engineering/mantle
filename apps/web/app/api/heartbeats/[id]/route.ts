import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { deleteHeartbeat, getHeartbeat, updateHeartbeat } from '@/lib/heartbeats';
import { UpdateHeartbeatBody, toUpdateInput } from '@/lib/heartbeat-schema';

/** One owner-scoped heartbeat (summary), or 404. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  const heartbeat = await getHeartbeat(user.id, id);
  if (!heartbeat) return NextResponse.json({ error: 'Heartbeat not found.' }, { status: 404 });
  return NextResponse.json({ heartbeat });
}

/** Partial update — also the pause/resume path (`{ status }`). Only the keys
 *  present in the body are written; a status-only PATCH leaves config intact. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  const parsed = UpdateHeartbeatBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }
  try {
    const heartbeat = await updateHeartbeat(user.id, id, toUpdateInput(parsed.data));
    if (!heartbeat) return NextResponse.json({ error: 'Heartbeat not found.' }, { status: 404 });
    return NextResponse.json({ heartbeat });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

/** Delete a heartbeat (its fire history cascades). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  const ok = await deleteHeartbeat(user.id, id);
  if (!ok) return NextResponse.json({ error: 'Heartbeat not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
