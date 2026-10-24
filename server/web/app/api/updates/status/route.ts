/**
 * Poll target for the /settings/updates progress view. Returns the updater
 * sidecar's status + log tail and the RUNNING app version — the client uses
 * the version flipping (after the web container is recreated mid-update) as
 * the "we're on the new build" signal to reload.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { readUpdaterLog, readUpdaterStatus, updaterAvailable } from '@/lib/updates';
import { APP_VERSION } from '@mantle/client-types/version';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/** Needs the settings area (the owner's decision, 2026-10-14): the gate
 *  answers before it. */
export async function GET() {
  ownerCaller();
  const [available, status, log] = await Promise.all([
    updaterAvailable(),
    readUpdaterStatus(),
    readUpdaterLog(),
  ]);
  return NextResponse.json({ available, status, log, version: APP_VERSION });
}
