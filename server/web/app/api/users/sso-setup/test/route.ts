import { oidcModeWord } from '@mantle/config';
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';
import { ssoSetupTest } from '@/lib/oidc/sso-setup';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'users',
    item: { none: 'manages the users area: the Admin step checks it' },
    limits: { rateLimit: ['ssoSetup'] },
  },
});

/**
 * POST /api/users/sso-setup/test: one Test of the provider with the values
 * the lock will use, only with the mode word `setup` (docs/oidc-sign-in.md).
 * One fixed code, never provider text.
 */
export async function POST() {
  ownerCaller();
  if (oidcModeWord() !== 'setup') {
    return NextResponse.json(
      { error: 'The setup screen is locked.', code: 'setup-closed' },
      { status: 403 },
    );
  }
  return NextResponse.json({ outcome: await ssoSetupTest() });
}
