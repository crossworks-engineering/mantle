import { publicLoginItself } from '@/lib/auth';
import { oidcStartFresh } from '@/lib/oidc/flow';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    public: true,
    caller: 'publicLogin',
    item: { none: "the login's own things, not an item" },
    limits: { crossSite: 'json', rateLimit: ['oidcLink'] },
  },
});

/**
 * POST /api/auth/oidc/fresh { redirect, challenge }: a linked login starts a
 * fresh company sign-in, in place of its password at key creation and MCP
 * consent; answers `{ url }` to open in a browser. Off: 404
 * (docs/oidc-sign-in.md).
 */
export function POST(req: Request) {
  return oidcStartFresh(req, async () => await publicLoginItself());
}
