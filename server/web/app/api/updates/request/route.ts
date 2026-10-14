import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { requestUpdate } from '@/lib/updates';
import { serviceRunBusy } from '@/lib/services';
import { ownerCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';

const Body = z
  .object({
    target: z.string().min(1).optional(),
    clientTarget: z.string().min(1).optional(),
  })
  .refine((b) => b.target || b.clientTarget, { message: 'target or clientTarget required' });

/** Ask the updater sidecar to roll: `target` is the server release tag (the
 *  sidecar pairs the owner UI from the target image), `clientTarget` alone
 *  rolls just the interface. Returns the updater's {ok}|{ok:false,error}
 *  result with a 200 so the client can branch on it (a sidecar-absent / busy
 *  state isn't an HTTP error). */
export async function POST(req: Request) {
  ownerCaller();
  const body = await readBody(req, Body);
  // One change to the box at a time: a service switch recreates containers too.
  if (await serviceRunBusy()) {
    return NextResponse.json({
      ok: false,
      error: 'A service is being switched on or off. Try again when it has finished.',
    });
  }
  return NextResponse.json(await requestUpdate(body.target ?? null, body.clientTarget ?? null));
}
