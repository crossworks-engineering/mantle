import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { getLiveActivity } from '@/lib/journey';

/**
 * Live activity for the always-on Activity surfaces (the app-shell column and
 * the /debug/journey header). Returns what's running now, what recently
 * succeeded (what entered the brain), and recent failures — human-labelled +
 * with outcome counts. Polled client-side; owner-scoped via getOwnerOr401 (a
 * JSON API — 401s an unauthenticated/expired client rather than redirecting).
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const live = await getLiveActivity(user.id);
  return NextResponse.json(live, { headers: { 'Cache-Control': 'no-store' } });
}
