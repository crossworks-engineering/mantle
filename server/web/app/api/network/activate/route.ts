import { NextResponse } from '@/server/http-compat';
import {
  getTailscaleConfig,
  getTailscaleAuthKey,
  markTailscaleActivated,
} from '@/lib/tailscale-config';
import { tailnetUp } from '@/lib/tailscale';
import { getOwnerOr401 } from '@/lib/auth';

/** Decrypt the stored key and drive tailscaled login over the socket. The join
 *  is async — the UI polls /api/network for `Running` after this returns ok. */
export async function POST() {
  const owner = await getOwnerOr401();
  if (owner instanceof Response) return owner;
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
