import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { fireOptsFor, getHeartbeatRow } from '@/lib/heartbeats';
import { forceFire } from '@mantle/runtime/heartbeats';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'assistants',
    item: { none: 'manages the assistants area: the Admin step checks it' },
  },
});

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
  // Another login (FireRefused) answers 403 by the one table (A10 part 2);
  // a failed fire is recorded on the fire row, anything thrown is a fault.
  await forceFire(row, await fireOptsFor(user.id, user.actor.id, row));
  return NextResponse.json({ ok: true });
}
