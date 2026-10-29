import { handleTokenLogin } from '@/lib/token-login';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'self',
    public: true,
    item: { none: "the login's own things, not an item" },
    limits: { rateLimit: ['authTokenLogin'] },
  },
});

/**
 * Mobile companion login. Same credentials as the web login, but instead of a
 * session cookie it returns a per-device bearer token (stored hashed-by-id in
 * mobile_tokens, revocable per device). Lives under /api/auth, which is public
 * (bypasses the session middleware) — see auth-constants.ts.
 *
 * Kept as a stable alias of the shared token-login flow (lib/token-login.ts)
 * with the original 1-year TTL — every shipped companion build depends on this
 * path and response shape. The web client uses /api/auth/token (30d + refresh).
 * Admins only: the companion calls admin routes only, so a non-Admin login
 * is refused here instead of getting a broken app: a member gets 426
 * `update-app` "Update the app" (a build that serves every login signs in
 * through /api/auth/device-login or QR pairing). There is no client login.
 */
export async function POST(req: Request) {
  return handleTokenLogin(req, {
    path: '/api/auth/mobile-login',
    channel: 'mobile',
    defaultLabel: 'Mobile device',
    adminsOnly: true,
  });
}
