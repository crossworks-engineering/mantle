import { NextResponse } from '@/server/http-compat';
import {
  checkForUpdate,
  readComposeStatus,
  readUpdaterStatus,
  updaterAvailable,
} from '@/lib/updates';
import { APP_VERSION, GIT_SHA, BUILD_TIME } from '@mantle/web-ui/version';
import { getOwnerOr401 } from '@/lib/auth';

/** Initial-load bundle for /settings/updates — the release check, whether the
 *  updater sidecar is present, the last updater status, and this build's
 *  identity. (The page polls /api/updates/status thereafter.) */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [check, available, status, compose] = await Promise.all([
    checkForUpdate(false),
    updaterAvailable(),
    readUpdaterStatus(),
    readComposeStatus(),
  ]);
  return NextResponse.json({
    check,
    available,
    status,
    compose,
    build: { version: APP_VERSION, sha: GIT_SHA, time: BUILD_TIME },
  });
}
