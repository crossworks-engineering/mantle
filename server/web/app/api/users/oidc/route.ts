import { ownerCaller } from '@/lib/auth';
import { oidcAdminSummary } from '@/lib/oidc/flow';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'users' },
});

/**
 * GET /api/users/oidc: company sign-in for the users area: how many active
 * logins are linked, and each one with its link and outside mark. Off:
 * `{ mode: 'off' }` (docs/oidc-sign-in.md).
 */
export function GET() {
  // The users area's Admin user, answered by the gate (the row's caller).
  ownerCaller();
  return oidcAdminSummary();
}
