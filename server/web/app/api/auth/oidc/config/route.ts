import { oidcConfigAnswer } from '@/lib/oidc/flow';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', public: true },
});

/**
 * GET /api/auth/oidc/config: the company sign-in mode and the button's
 * label, for the sign-in screen (public, before anyone signs in; no secret,
 * no issuer). Off: `{ mode: 'off' }`, and the screen stays as it is
 * (docs/oidc-sign-in.md).
 */
export function GET() {
  return oidcConfigAnswer();
}
