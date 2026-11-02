import { NextResponse } from '@/server/http-compat';
import { isFirstRun } from '@/lib/auth';
import { passwordRule } from '@/lib/auth/password-rule';
import { setupCodeConfigured } from '@/lib/auth/setup-code';
import type { BootstrapStateDTO } from '@mantle/client-types';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', public: true },
});

/**
 * GET /api/auth/bootstrap-state: is this a fresh install (no user yet), and
 * does its signup ask for the installer's setup code? Public (pre-auth) so a
 * detached login screen can choose sign-in vs. create-account, and show the
 * setup-code field, without DB access. Only booleans leak; the signup
 * endpoint enforces the single-user gate and the code server-side regardless.
 * It also carries the rule a new password must meet, so a signup, invite or
 * change form can show it as the person types (the same for every caller).
 */
export async function GET() {
  const firstRun = await isFirstRun();
  const body: BootstrapStateDTO = {
    firstRun,
    setupCodeRequired: firstRun && setupCodeConfigured(),
    passwordRule: passwordRule(),
  };
  return NextResponse.json(body);
}
