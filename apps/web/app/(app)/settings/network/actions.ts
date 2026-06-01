'use server';

import { requireOwner } from '@/lib/auth';
import {
  setTailscaleConfig,
  getTailscaleConfig,
  getTailscaleAuthKey,
  markTailscaleActivated,
  clearTailscaleConfig,
} from '@/lib/tailscale-config';
import { tailnetUp, tailnetDown } from '@/lib/tailscale';

export type NetworkActionResult = { ok: boolean; message: string };

/** Seal + store the auth key and device name. */
export async function saveTailscaleKeyAction(
  authKey: string,
  hostname: string,
): Promise<NetworkActionResult> {
  const owner = await requireOwner();
  const key = authKey.trim();
  const host = hostname.trim() || 'mantle';
  if (!key) return { ok: false, message: 'Paste a Tailscale auth key.' };
  if (!/^tskey-/.test(key)) {
    return { ok: false, message: 'That does not look like a Tailscale auth key (expected tskey-…).' };
  }
  try {
    await setTailscaleConfig(owner.id, key, host);
    return { ok: true, message: 'Auth key saved. Click Activate to join the tailnet.' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Decrypt the stored key and drive tailscaled login over the socket. The join
 *  is async — the UI polls status for `Running` after this returns ok. */
export async function activateTailnetAction(): Promise<NetworkActionResult> {
  const owner = await requireOwner();
  const key = await getTailscaleAuthKey(owner.id);
  if (!key) return { ok: false, message: 'No auth key saved yet — save one first.' };
  const config = await getTailscaleConfig(owner.id);
  const hostname = config?.hostname || 'mantle';
  const r = await tailnetUp(key, hostname);
  if (!r.ok) return { ok: false, message: `Activation failed: ${r.reason}` };
  await markTailscaleActivated(owner.id);
  return { ok: true, message: 'Login started — waiting for the tailnet to come up…' };
}

/** Log tailscaled out (leave the tailnet). */
export async function deactivateTailnetAction(): Promise<NetworkActionResult> {
  await requireOwner();
  const r = await tailnetDown();
  if (!r.ok) return { ok: false, message: `Deactivation failed: ${r.reason}` };
  return { ok: true, message: 'Left the tailnet.' };
}

/** Forget the stored key (does not log the running session out). */
export async function clearTailscaleKeyAction(): Promise<NetworkActionResult> {
  const owner = await requireOwner();
  await clearTailscaleConfig(owner.id);
  return { ok: true, message: 'Stored auth key removed.' };
}
