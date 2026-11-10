/**
 * GET /scim/v2/ServiceProviderConfig: a SCIM discovery document (lib/scim/discovery.ts),
 * under the box's SCIM token; off, 404 (docs/scim.md). Not a Control
 * Center: the same 404, with no SCIM code loaded.
 */
import { routePolicy } from '@/lib/auth/route-declaration';
import { ccOff } from '@/lib/control/env';

export const policy = routePolicy({
  GET: { class: 'public', limits: { rateLimit: ['scim'] } },
});

export async function GET(req: Request) {
  const off = ccOff();
  if (off) return off;
  const [{ serviceProviderConfig }, { scimBase, scimGate, scimJson }] = await Promise.all([
    import('@/lib/scim/discovery'),
    import('@/lib/scim/service'),
  ]);
  return (await scimGate(req)) ?? scimJson(serviceProviderConfig(scimBase()));
}
