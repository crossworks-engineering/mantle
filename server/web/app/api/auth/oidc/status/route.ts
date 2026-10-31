import { publicLoginItself } from '@/lib/auth';
import { oidcStatusAnswer } from '@/lib/oidc/flow';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', public: true, caller: 'publicLogin' },
});

/**
 * GET /api/auth/oidc/status: the signed-in login's company sign-in: linked
 * or not, whether to show the "link now" offer, whether it must link before
 * it goes on. Off: `{ mode: 'off' }` (docs/oidc-sign-in.md). A public row:
 * the login is the one the pipeline answers at the read.
 */
export function GET() {
  // Awaited where it is called (owner-caller-imports): read only once the
  // mode is on.
  return oidcStatusAnswer(async () => await publicLoginItself());
}
