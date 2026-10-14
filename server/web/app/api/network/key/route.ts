import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { setTailscaleConfig, clearTailscaleConfig } from '@/lib/tailscale-config';
import { ownerCaller } from '@/lib/auth';
import { errorMessage } from '@mantle/std';
import { readJson } from '@/lib/read-body';

type NetworkResult = { ok: boolean; message: string };
const json = (r: NetworkResult) => NextResponse.json(r);

const Body = z.object({ authKey: z.string(), hostname: z.string() });

/** Seal + store the Tailscale auth key and device name. Returns {ok,message}
 *  (always 200) so the UI branches on it like the old server action did. */
export async function POST(req: Request) {
  const owner = ownerCaller();
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return json({ ok: false, message: 'Invalid input.' });
  const key = parsed.data.authKey.trim();
  const host = parsed.data.hostname.trim() || 'mantle';
  if (!key) return json({ ok: false, message: 'Paste a Tailscale auth key.' });
  if (!/^tskey-/.test(key)) {
    return json({
      ok: false,
      message: 'That does not look like a Tailscale auth key (expected tskey-…).',
    });
  }
  try {
    await setTailscaleConfig(owner.id, key, host);
    return json({ ok: true, message: 'Auth key saved. Click Activate to join the tailnet.' });
  } catch (err) {
    return json({ ok: false, message: errorMessage(err) });
  }
}

/** Forget the stored key (does not log the running session out). */
export async function DELETE() {
  const owner = ownerCaller();
  await clearTailscaleConfig(owner.id);
  return json({ ok: true, message: 'Stored auth key removed.' });
}
