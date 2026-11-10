/**
 * GET /api/fleet/matrix: the fleet matrix (docs/control-center.md, "The
 * fleet matrix"): per linked box its last good facts (box status numbers,
 * the company sign-in mode, each agent's and AI worker's provider and
 * model, two counts, the last backup) and why the last read failed, if it
 * did. `?box=<id>` reads one box. Read only. Not a CC: 404, with no CC code
 * loaded.
 */
import { NextResponse } from '@/server/http-compat';
import { InputError, isUuid } from '@mantle/std';
import { ownerCaller } from '@/lib/auth';
import { ccOff } from '@/lib/control/env';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

export async function GET(req: Request) {
  ownerCaller();
  const off = ccOff();
  if (off) return off;
  const box = new URL(req.url).searchParams.get('box');
  if (box !== null && !isUuid(box)) throw new InputError('box must be a box id.');
  const { listControlMatrix } = await import('@mantle/db/control-center');
  return NextResponse.json({ boxes: await listControlMatrix(box ?? undefined) });
}
