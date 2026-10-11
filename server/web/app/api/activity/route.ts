import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getLiveActivity } from '@/lib/journey';
import { toolMakerFor } from '@/lib/tools';

/**
 * Live activity for the always-on Activity surfaces (the app-shell column and
 * the /debug/journey header). Returns what's running now, what recently
 * succeeded (what entered the brain), and recent failures — human-labelled +
 * with outcome counts. Polled client-side; owner-scoped via getOwnerOr401 (a
 * JSON API — 401s an unauthenticated/expired client rather than redirecting).
 * Only the traces the signed-in login may read (W7 integration fix 4, L2).
 */

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const live = await getLiveActivity(user.id, toolMakerFor(user));
  return NextResponse.json(live, { headers: { 'Cache-Control': 'no-store' } });
}
