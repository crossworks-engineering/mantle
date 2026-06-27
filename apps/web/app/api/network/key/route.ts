import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setTailscaleConfig, clearTailscaleConfig } from '@/lib/tailscale-config';
import { getOwnerOr401 } from '@/lib/auth';

type NetworkResult = { ok: boolean; message: string };
const json = (r: NetworkResult) => NextResponse.json(r);

const Body = z.object({ authKey: z.string(), hostname: z.string() });

/** Seal + store the Tailscale auth key and device name. Returns {ok,message}
 *  (always 200) so the UI branches on it like the old server action did. */
export async function POST(req: Request) {
  const owner = await getOwnerOr401();
  if (owner instanceof Response) return owner;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json({ ok: false, message: 'Invalid input.' });
  const key = parsed.data.authKey.trim();
  const host = parsed.data.hostname.trim() || 'mantle';
  if (!key) return json({ ok: false, message: 'Paste a Tailscale auth key.' });
  if (!/^tskey-/.test(key)) {
    return json({ ok: false, message: 'That does not look like a Tailscale auth key (expected tskey-…).' });
  }
  try {
    await setTailscaleConfig(owner.id, key, host);
    return json({ ok: true, message: 'Auth key saved. Click Activate to join the tailnet.' });
  } catch (err) {
    return json({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
}

/** Forget the stored key (does not log the running session out). */
export async function DELETE() {
  const owner = await getOwnerOr401();
  if (owner instanceof Response) return owner;
  await clearTailscaleConfig(owner.id);
  return json({ ok: true, message: 'Stored auth key removed.' });
}
