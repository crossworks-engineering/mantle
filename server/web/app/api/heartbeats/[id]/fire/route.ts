import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { FireRefused, fireOptsFor, getHeartbeatRow } from '@/lib/heartbeats';
import { forceFire } from '@mantle/runtime/heartbeats';
import { errorMessage } from '@mantle/std';

/**
 * Fire a heartbeat immediately, bypassing its gates (idle / quiet / cooldown) —
 * the "Fire now" button. Loads the FULL row (the summary trims fields forceFire
 * needs). Was the `fireNowAction` server action.
 *
 * Only the heartbeat's maker fires it (W7 integration fix 4, fireOptsFor):
 * another login gets a 403. A maker other than the brain owner fires in its
 * own scope (W7a fix round 3), as the heartbeat_fire tool does: the turn
 * answers that login, never the anchor.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await params;
  const row = await getHeartbeatRow(user.id, id);
  if (!row) return NextResponse.json({ error: 'Heartbeat not found.' }, { status: 404 });
  try {
    await forceFire(row, await fireOptsFor(user.id, user.actor.id, row));
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof FireRefused) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 });
  }
}
