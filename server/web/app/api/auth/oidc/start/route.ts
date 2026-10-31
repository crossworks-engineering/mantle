import { oidcStartSignIn } from '@/lib/oidc/flow';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', public: true, limits: { rateLimit: ['oidcStart'] } },
});

/**
 * GET /api/auth/oidc/start?return=<path>: company sign-in, off to the
 * provider (a top-level navigation; the flow's state, nonce and PKCE
 * verifier go in a signed 10-minute cookie). Off: 404
 * (docs/oidc-sign-in.md).
 */
export function GET(req: Request) {
  return oidcStartSignIn(req);
}
