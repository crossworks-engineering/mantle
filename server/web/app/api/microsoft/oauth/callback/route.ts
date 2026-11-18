/**
 * GET /api/microsoft/oauth/callback (Sync service plan M3): the redirect URI
 * a Microsoft app registered before M4 names. The same as
 * /api/services/sync/oauth/callback (lib/sync-oauth.ts), so such an app
 * needs no change.
 */
import { routePolicy } from '@/lib/auth/route-declaration';
import { syncOAuthCallback } from '@/lib/sync-oauth';

export const policy = routePolicy({
  // A public row: it judges its own credential (the sign-in's cookie and
  // state). No rate limit: a refusal does no work.
  GET: { class: 'public' },
});

export async function GET(req: Request) {
  return syncOAuthCallback(req);
}
