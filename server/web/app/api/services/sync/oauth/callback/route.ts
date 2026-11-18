/**
 * GET /api/services/sync/oauth/callback (Sync service plan M3): Microsoft's
 * redirect after a sign-in started at /api/services/sync/oauth/start. The
 * state must equal the sign-in's cookie; the sidecar checks the state and
 * the PKCE verifier and keeps the tokens (lib/sync-oauth.ts).
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
