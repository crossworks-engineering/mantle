/**
 * The brain's side of the Sync sidecar's calls (/api/sidecar/*; Sync service
 * plan M2, docs/services.md "Sync"). The sidecar (server/sync) holds no
 * database login and no master key: it reads and writes its state, and
 * hands over the mail and events it fetched, through these routes, with
 * SYNC_TOKEN in `x-mantle-sync-token`, straight from the stack's network.
 *
 * Every route here runs as the system actor `worker:sync`, as the old mail
 * and calendar workers did, after the token check.
 */
import { resolveSingleOwnerId, runAsSystem } from '@mantle/db';
import { env, serviceEnabled } from '@mantle/config';
import { NextResponse } from '@/server/http-compat';
import { internalTokenRefusal } from '@/lib/gateway-internal';

export { SIDECAR_SERVICE, openState, sealState } from '@/lib/sidecar-state';

/** The header the sidecar's token travels in, both ways. */
export const SYNC_TOKEN_HEADER = 'x-mantle-sync-token';

/** Null when the request is the Sync sidecar's, else the answer to send. A
 *  box with Sync off answers 404: nothing there may call. */
export function sidecarRequestRefusal(req: Request): Response | null {
  const refused = internalTokenRefusal(req, env('SYNC_TOKEN'), SYNC_TOKEN_HEADER);
  if (refused) return refused;
  if (!serviceEnabled('sync')) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return null;
}

/** Run a sidecar route's work as the sync worker. */
export function asSidecar<T>(fn: () => Promise<T>): Promise<T> {
  return runAsSystem('worker:sync', fn);
}

/** The brain's owner: every sidecar account's data lands under it (Sync
 *  plan decision 1, as before M4). */
export async function sidecarOwner(): Promise<string> {
  const owner = await resolveSingleOwnerId();
  if (!owner) throw new Error('no owner on this box yet');
  return owner;
}
