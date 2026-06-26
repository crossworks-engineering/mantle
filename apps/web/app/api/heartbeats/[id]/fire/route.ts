import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { getHeartbeatRow } from '@/lib/heartbeats';
import { forceFire } from '@mantle/heartbeats';

/**
 * Fire a heartbeat immediately, bypassing its gates (idle / quiet / cooldown) —
 * the "Fire now" button. Loads the FULL row (the summary trims fields forceFire
 * needs). Was the `fireNowAction` server action.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;
  const row = await getHeartbeatRow(user.id, id);
  if (!row) return NextResponse.json({ error: 'Heartbeat not found.' }, { status: 404 });
  try {
    await forceFire(row);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
