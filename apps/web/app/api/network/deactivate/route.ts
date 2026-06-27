import { NextResponse } from 'next/server';
import { tailnetDown } from '@/lib/tailscale';
import { getOwnerOr401 } from '@/lib/auth';

/** Log tailscaled out (leave the tailnet). */
export async function POST() {
  const owner = await getOwnerOr401();
  if (owner instanceof Response) return owner;
  const r = await tailnetDown();
  if (!r.ok) return NextResponse.json({ ok: false, message: `Deactivation failed: ${r.reason}` });
  return NextResponse.json({ ok: true, message: 'Left the tailnet.' });
}
