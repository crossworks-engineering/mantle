import { WEB_TOKEN_TTL_SECONDS } from '@/lib/auth';
import { handleTokenLogin } from '@/lib/token-login';

/**
 * Web-client token login — the owner UI's credential→bearer exchange for the
 * two-origin (split) topology, where the client origin can't use the session
 * cookie. 30-day TTL, rotated opportunistically via /api/auth/token/refresh;
 * revocable per device (Settings → Security → Signed-in devices).
 *
 * Lives under the public /api/auth prefix. CORS: the middleware refuses a
 * wildcard MANTLE_API_CORS_ORIGINS on /api/auth/* — the client origin must be
 * listed explicitly.
 */
export async function POST(req: Request) {
  return handleTokenLogin(req, {
    path: '/api/auth/token',
    channel: 'web-client',
    ttlSeconds: WEB_TOKEN_TTL_SECONDS,
    defaultLabel: 'Web client',
  });
}
