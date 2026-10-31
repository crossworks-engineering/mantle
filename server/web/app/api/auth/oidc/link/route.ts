import { publicLoginItself } from '@/lib/auth';
import { oidcStartLink, oidcUnlinkSelf } from '@/lib/oidc/flow';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    public: true,
    caller: 'publicLogin',
    item: { none: "the login's own things, not an item" },
    limits: { crossSite: 'json', rateLimit: ['oidcLink'] },
  },
  DELETE: {
    class: 'self',
    public: true,
    caller: 'publicLogin',
    item: { none: "the login's own things, not an item" },
    limits: { crossSite: 'origin' },
  },
});

/**
 * POST /api/auth/oidc/link { password?, returnTo? }: start linking the
 * signed-in login (or the login a required-mode password sign-in held) to
 * a company account; answers `{ url }` for the window to open. DELETE: the
 * login removes its own link where it may. Off: 404
 * (docs/oidc-sign-in.md).
 */
export function POST(req: Request) {
  return oidcStartLink(req, async () => await publicLoginItself());
}

export function DELETE(req: Request) {
  return oidcUnlinkSelf(req, async () => await publicLoginItself());
}
