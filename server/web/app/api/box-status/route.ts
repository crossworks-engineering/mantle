import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { boxStatusView } from '@/lib/box-status';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/**
 * GET /api/box-status: the owner UI's Status screen. The box_status
 * collector (lib/box-status.ts: build, host load, memory and disk, Postgres,
 * each service up or down, spend, corpus capacity, the extractor's queue,
 * logins) and every long-running container as the updater sidecar last saw
 * it (state, health, restarts). Numbers and fixed words only, never a name
 * or a host; read-only, never cached by the browser (/api is no-store), and
 * the collection is shared for 30 seconds, so a polling screen costs no more
 * than one.
 */
export async function GET() {
  const user = ownerCaller();
  return NextResponse.json(await boxStatusView(user.id));
}
