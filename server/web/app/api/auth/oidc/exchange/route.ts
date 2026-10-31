import { oidcExchange } from '@/lib/oidc/exchange';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    public: true,
    item: { none: "the login's own things, not an item" },
    limits: { crossSite: 'json', rateLimit: ['oidcExchange'] },
  },
});

/**
 * POST /api/auth/oidc/exchange { code, verifier, deviceName? }: a client spends
 * the one-time code its company sign-in came back with, for a bearer or a
 * link. Public: the code and the verifier are the proof. Off: 404
 * (docs/oidc-sign-in.md).
 */
export function POST(req: Request) {
  return oidcExchange(req);
}
