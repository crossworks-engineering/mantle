import { NextResponse } from '@/server/http-compat';
import { getTailnetStatus } from '@/lib/tailscale';
import { getTailscaleConfig } from '@/lib/tailscale-config';
import { ownerCaller } from '@/lib/auth';

/** Tailnet connection state + the stored auth-key summary for /settings/network. */
export async function GET() {
  const owner = ownerCaller();
  const [status, config] = await Promise.all([getTailnetStatus(), getTailscaleConfig(owner.id)]);
  return NextResponse.json({ status, config });
}
