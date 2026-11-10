/**
 * POST /api/control/call (docs/control-center.md): the Control Center's
 * signed call to this box. No session: the credential is the CC's Ed25519
 * signature over the raw body, for this box's own origin, within 60
 * seconds, checked against the public key in the box .env before the JSON
 * is read. Then a fixed switch of seven cases (hello, logins, facts,
 * disable, enable, archive, key): not tools, so no agent, MCP client or API key on the box
 * reaches them. A box with no .env lines answers 404.
 */
import { routePolicy } from '@/lib/auth/route-declaration';
import { handleControlCall } from '@/lib/control/box';

export const policy = routePolicy({
  POST: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the Control Center's signature)" },
    limits: { rateLimit: ['controlCall'] },
    audit: 'own',
  },
});

export async function POST(req: Request) {
  return handleControlCall(req);
}
