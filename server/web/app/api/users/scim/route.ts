import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { isControlCenter } from '@/lib/control/env';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'users' },
});

/**
 * GET /api/users/scim: SCIM for the users area (docs/scim.md). Off:
 * `{ on: false }`, with no read; off a Control Center always, with no SCIM
 * code loaded. On: the base URL to give the provider and how many logins it
 * manages, and how many of those are disabled.
 */
export async function GET() {
  ownerCaller();
  if (!isControlCenter()) return NextResponse.json({ on: false });
  const [{ scimOn }, { scimBase }, { scimCounts }] = await Promise.all([
    import('@/lib/scim/settings'),
    import('@/lib/scim/service'),
    import('@/lib/scim/store'),
  ]);
  if (!(await scimOn())) return NextResponse.json({ on: false });
  return NextResponse.json({ on: true, url: scimBase(), ...(await scimCounts()) });
}
