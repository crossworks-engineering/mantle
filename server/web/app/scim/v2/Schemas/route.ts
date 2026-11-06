/**
 * GET /scim/v2/Schemas: a SCIM discovery document (lib/scim/discovery.ts),
 * under the box's SCIM token; off, 404 (docs/scim.md).
 */
import { routePolicy } from '@/lib/auth/route-declaration';
import { schemas } from '@/lib/scim/discovery';
import { scimBase, scimGate, scimJson } from '@/lib/scim/service';

export const policy = routePolicy({
  GET: { class: 'public', limits: { rateLimit: ['scim'] } },
});

export async function GET(req: Request) {
  return (await scimGate(req)) ?? scimJson(schemas(scimBase()));
}
