import { publicLoginItself } from '@/lib/auth';
import { oidcCallback } from '@/lib/oidc/flow';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: {
    // Never the password hold's answer: a sign-in callback acts as the
    // login it signs in, not as the cookie it meets (a held password
    // cookie must not turn company sign-in into a raw 401 or 403). The new
    // session meets the hold, by its own kind, on its next request; a link
    // started only on a session the hold let through.
    passwordHold: 'sign-out',
    class: 'self',
    public: true,
    caller: 'publicLogin',
    effect: {
      write:
        'the company sign-in callback: it signs a linked login in, or links the account to the login that started the link',
    },
    item: { none: "the login's own things, not an item" },
    limits: { rateLimit: ['oidcCallback'] },
  },
});

/**
 * GET /api/auth/oidc/callback: back from the provider (the redirect URI an
 * operator registers). Trades the code for the ID token, then signs in the
 * login the account is linked to, or finishes a link. Never makes a login,
 * never links by email. Off: 404 (docs/oidc-sign-in.md).
 */
export function GET(req: Request) {
  return oidcCallback(req, async () => await publicLoginItself());
}
