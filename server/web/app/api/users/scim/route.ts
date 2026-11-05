import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { scimOn } from '@/lib/scim/settings';
import { scimBase } from '@/lib/scim/service';
import { scimCounts } from '@/lib/scim/store';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'users' },
});

/**
 * GET /api/users/scim: SCIM for the users area (docs/scim.md). Off:
 * `{ on: false }`, with no read. On: the base URL to give the provider and
 * how many logins it manages, and how many of those are disabled.
 */
export async function GET() {
  ownerCaller();
  if (!scimOn()) return NextResponse.json({ on: false });
  return NextResponse.json({ on: true, url: scimBase(), ...(await scimCounts()) });
}
