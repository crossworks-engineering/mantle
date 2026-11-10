/**
 * The Control Center's Fleet area (docs/control-center.md): what the Fleet
 * routes (app/api/fleet) answer. CC code: a route loads this module only
 * after ccOff (./env.ts) let it on, so off a CC it is never in memory. The
 * control_* tools (packages/tools builtins-control.ts) do the same over MCP.
 */
import { env } from '@mantle/config';
import {
  controlServiceState,
  listControlBans,
  listControlBoxes,
  listControlResults,
} from '@mantle/db/control-center';

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
