/**
 * GET /api/fleet: the Control Center's Fleet screen in one read
 * (docs/control-center.md): the control service's public key and the two
 * .env lines a subject box sets, the linked boxes with their last run, the
 * bans, and per ban and box what the last run matched (the box owner in
 * ownerIds when it matched). Not a CC: 404.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { fleetOff, fleetOverview } from '@/lib/control/fleet';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

export async function GET() {
  ownerCaller();
  return fleetOff() ?? NextResponse.json(await fleetOverview());
}
