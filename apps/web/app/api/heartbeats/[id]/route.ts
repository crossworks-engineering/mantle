import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { getHeartbeat } from '@/lib/heartbeats';

/** One owner-scoped heartbeat (summary), or 404. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  const heartbeat = await getHeartbeat(user.id, id);
  if (!heartbeat) return NextResponse.json({ error: 'Heartbeat not found.' }, { status: 404 });
  return NextResponse.json({ heartbeat });
}
