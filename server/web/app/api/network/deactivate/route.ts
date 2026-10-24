import { NextResponse } from '@/server/http-compat';
import { tailnetDown } from '@/lib/tailscale';
import { ownerCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/** Log tailscaled out (leave the tailnet). */
export async function POST() {
  ownerCaller();
  const r = await tailnetDown();
  if (!r.ok) return NextResponse.json({ ok: false, message: `Deactivation failed: ${r.reason}` });
  return NextResponse.json({ ok: true, message: 'Left the tailnet.' });
}
