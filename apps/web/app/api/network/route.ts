import { NextResponse } from 'next/server';
import { getTailnetStatus } from '@/lib/tailscale';
import { getTailscaleConfig } from '@/lib/tailscale-config';
import { getOwnerOr401 } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Tailnet connection state + the stored auth-key summary for /settings/network. */
export async function GET() {
  const owner = await getOwnerOr401();
  if (owner instanceof Response) return owner;
  const [status, config] = await Promise.all([getTailnetStatus(), getTailscaleConfig(owner.id)]);
  return NextResponse.json({ status, config });
}
