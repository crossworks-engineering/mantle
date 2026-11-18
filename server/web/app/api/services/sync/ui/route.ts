/**
 * GET and POST /api/services/sync/ui?p=<path>&t=<ticket> (Sync service plan
 * M2, decision 3): the Sync service's own screen, in the client's
 * sandboxed frame. The frame's requests carry no cookie: the ticket
 * (POST /api/services/sync/frame-ticket) is the credential, checked here
 * with its login's area (lib/service-screens.ts), and renewed in every screen.
 */
import { routePolicy } from '@/lib/auth/route-declaration';
import { serviceScreen } from '@/lib/service-screens';

export const policy = routePolicy({
  // A public row: it judges its own credential (the screen ticket). No rate
  // limit: a person's form clicks, each checked before any work.
  GET: { class: 'public' },
  POST: {
    class: 'public',
    item: { none: 'a public route: it judges its own credential (the screen ticket)' },
  },
});

export async function GET(req: Request) {
  return serviceScreen(req, 'sync');
}

export async function POST(req: Request) {
  return serviceScreen(req, 'sync');
}
