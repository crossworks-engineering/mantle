import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { getLiveActivity } from '@/lib/journey';
import { toolMakerFor } from '@/lib/tools';

/**
 * Live activity for the always-on Activity surfaces (the app-shell column and
 * the /debug/journey header). Returns what's running now, what recently
 * succeeded (what entered the brain), and recent failures — human-labelled +
 * with outcome counts. Polled client-side; owner-scoped by the owner answer
 * the pipeline gives (ownerCaller; a JSON API, so an unauthenticated or
 * expired client gets a 401 rather than a redirect).
 * Only the traces the signed-in login may read (W7 integration fix 4, L2).
 */

export async function GET() {
  const user = ownerCaller();
  const live = await getLiveActivity(user.id, toolMakerFor(user));
  return NextResponse.json(live);
}
