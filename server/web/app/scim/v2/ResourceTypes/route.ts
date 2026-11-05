/**
 * GET /scim/v2/ResourceTypes: a SCIM discovery document (lib/scim/discovery.ts),
 * under the box's SCIM token; off, 404 (docs/scim.md).
 */
import { routePolicy } from '@/lib/auth/route-declaration';
import { resourceTypes } from '@/lib/scim/discovery';
import { scimBase, scimGate, scimJson } from '@/lib/scim/service';

export const policy = routePolicy({
  GET: { class: 'public', limits: { rateLimit: ['scim'] } },
});

export function GET(req: Request) {
  return scimGate(req) ?? scimJson(resourceTypes(scimBase()));
}
