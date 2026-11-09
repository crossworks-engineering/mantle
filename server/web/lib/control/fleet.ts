/**
 * The Control Center's Fleet area (docs/control-center.md): what the Fleet
 * routes (app/api/fleet) answer. On a box that is not a CC every Fleet
 * route answers 404 and reads nothing. The control_* tools
 * (packages/tools builtins-control.ts) do the same over MCP.
 */
import { env } from '@mantle/config';
import {
  controlServiceState,
  listControlBans,
  listControlBoxes,
  listControlResults,
} from '@mantle/db';
import { NextResponse } from '@/server/http-compat';
import { isControlCenter } from './env';

/** 404 off a CC, else null. */
export function fleetOff(): Response | null {
  return isControlCenter() ? null : NextResponse.json({ error: 'not found' }, { status: 404 });
}

/** The two .env lines a subject box sets, for the screen to copy. Null
 *  until the control service has made its key. */
export function controlEnvLines(publicKey: string | null): string[] | null {
  if (!publicKey) return null;
  const url = (env('MANTLE_PUBLIC_URL') ?? '').trim().replace(/\/+$/, '');
  return [`MANTLE_CONTROL_CENTER=${url}`, `MANTLE_CONTROL_CENTER_KEY=${publicKey}`];
}

/** Everything the Fleet screen shows, in one read. */
export async function fleetOverview() {
  const [service, boxes, bans, results] = await Promise.all([
    controlServiceState(),
    listControlBoxes(),
    listControlBans({ lifted: true }),
    listControlResults(),
  ]);
  return {
    service,
    envLines: controlEnvLines(service?.publicKey ?? null),
    boxes,
    bans,
    results,
  };
}
