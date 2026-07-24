/**
 * Poll target for the /settings/updates progress view. Returns the updater
 * sidecar's status + log tail and the RUNNING app version — the client uses
 * the version flipping (after the web container is recreated mid-update) as
 * the "we're on the new build" signal to reload.
 */
import { NextResponse } from '@/server/http-compat';
import { getSessionUser } from '@/lib/auth';
import { readUpdaterLog, readUpdaterStatus, updaterAvailable } from '@/lib/updates';
import { APP_VERSION } from '@mantle/web-ui/version';


export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const [available, status, log] = await Promise.all([
    updaterAvailable(),
    readUpdaterStatus(),
    readUpdaterLog(),
  ]);
  return NextResponse.json({ available, status, log, version: APP_VERSION });
}
