/**
 * GET /api/services/sync/oauth/start?t=<screen ticket> (Sync service plan M3):
 * the Connect link of the Sync screens opens it in a new tab. It judges the
 * ticket with its login's area, then sends the browser to Microsoft's
 * sign-in (lib/sync-oauth.ts).
 */
import { routePolicy } from '@/lib/auth/route-declaration';
import { syncOAuthStart } from '@/lib/sync-oauth';

export const policy = routePolicy({
  // A public row: it judges its own credential (the screen ticket). No rate
  // limit: a person's click, checked before any work.
  GET: { class: 'public' },
});

export async function GET(req: Request) {
  return syncOAuthStart(req);
}
