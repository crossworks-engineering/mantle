import { NextResponse } from 'next/server';
import { checkForUpdate, readUpdaterStatus, updaterAvailable } from '@/lib/updates';
import { APP_VERSION, GIT_SHA, BUILD_TIME } from '@/lib/version';
import { getOwnerOr401 } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Initial-load bundle for /settings/updates — the release check, whether the
 *  updater sidecar is present, the last updater status, and this build's
 *  identity. (The page polls /api/updates/status thereafter.) */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [check, available, status] = await Promise.all([
    checkForUpdate(false),
    updaterAvailable(),
    readUpdaterStatus(),
  ]);
  return NextResponse.json({
    check,
    available,
    status,
    build: { version: APP_VERSION, sha: GIT_SHA, time: BUILD_TIME },
  });
}
