import { NextResponse } from '@/server/http-compat';
import {
  getTailscaleConfig,
  getTailscaleAuthKey,
  markTailscaleActivated,
} from '@/lib/tailscale-config';
import { tailnetUp } from '@/lib/tailscale';
import { ownerCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/** Decrypt the stored key and drive tailscaled login over the socket. The join
 *  is async — the UI polls /api/network for `Running` after this returns ok. */
export async function POST() {
  const owner = ownerCaller();
  const key = await getTailscaleAuthKey(owner.id);
  if (!key)
    return NextResponse.json({ ok: false, message: 'No auth key saved yet — save one first.' });
  const config = await getTailscaleConfig(owner.id);
  const hostname = config?.hostname || 'mantle';
  const r = await tailnetUp(key, hostname);
  if (!r.ok) return NextResponse.json({ ok: false, message: `Activation failed: ${r.reason}` });
  await markTailscaleActivated(owner.id);
  return NextResponse.json({
    ok: true,
    message: 'Login started — waiting for the tailnet to come up…',
  });
}
