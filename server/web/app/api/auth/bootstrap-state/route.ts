import { NextResponse } from '@/server/http-compat';
import { isFirstRun } from '@/lib/auth';
import { setupCodeConfigured } from '@/lib/auth/setup-code';
import type { BootstrapStateDTO } from '@mantle/client-types';

/**
 * GET /api/auth/bootstrap-state — is this a fresh install (no user yet), and
 * does its signup ask for the installer's setup code? Public (pre-auth) so a
 * detached login screen can choose sign-in vs. create-account, and show the
 * setup-code field, without DB access. Only booleans leak; the signup
 * endpoint enforces the single-user gate and the code server-side regardless.
 */
export async function GET() {
  const firstRun = await isFirstRun();
  const body: BootstrapStateDTO = {
    firstRun,
    setupCodeRequired: firstRun && setupCodeConfigured(),
  };
  return NextResponse.json(body);
}
