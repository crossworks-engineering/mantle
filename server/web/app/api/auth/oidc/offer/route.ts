import { publicLoginItself } from '@/lib/auth';
import { oidcDismissOffer } from '@/lib/oidc/flow';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    public: true,
    caller: 'publicLogin',
    item: { none: "the login's own things, not an item" },
    limits: { crossSite: 'origin' },
  },
});

/**
 * POST /api/auth/oidc/offer: the login hides the "link now" offer for 7
 * days (it stays in Settings > Profile). Off: 404 (docs/oidc-sign-in.md).
 */
export function POST(req: Request) {
  return oidcDismissOffer(req, async () => await publicLoginItself());
}
