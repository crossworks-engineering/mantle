import { WEB_TOKEN_TTL_SECONDS } from '@/lib/auth';
import { handleTokenLogin } from '@/lib/token-login';

/**
 * Phone app login for an ADMIN or a MEMBER (docs/mobile-companion-backend.md,
 * "Three roles on the phone"): email and password for a per-device bearer,
 * and the answer names the login (`role`, `loginId`) so the app knows which
 * shell to call. 30 days, rotated through /api/auth/token/refresh; listed and
 * revoked per device like every bearer (Settings > Logins > Devices).
 *
 * The successor of /api/auth/mobile-login, which stays frozen (admins only,
 * one year) for shipped builds. A client has no password: its email answers
 * the same 401 as a wrong one, and it signs in with the emailed code
 * (/api/auth/client-code, device mode). Public under /api/auth, sets no
 * cookie, shares the token-login rate limit.
 */
export async function POST(req: Request) {
  return handleTokenLogin(req, {
    path: '/api/auth/device-login',
    channel: 'mobile',
    ttlSeconds: WEB_TOKEN_TTL_SECONDS,
    defaultLabel: 'Mobile device',
    withRole: true,
  });
}
