/**
 * The owner's Tailscale auth key + device name, sealed at rest. Web-only (the
 * app process owns the tailscaled socket), so this lives in apps/web/lib rather
 * than a shared package. Mirrors @mantle/api-keys: seal with the row id as AAD,
 * never surface plaintext to the UI (only `masked`).
 */
import 'server-only';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, tailscaleConfig } from '@mantle/db';
import { seal, open } from '@mantle/crypto';
import { maskPlaintext } from '@mantle/api-keys';

export type TailscaleConfigSummary = {
  hostname: string;
  masked: string;
  lastActivatedAt: Date | null;
};

/** Masked summary for the UI — never the plaintext key. */
export async function getTailscaleConfig(ownerId: string): Promise<TailscaleConfigSummary | null> {
  const [row] = await db
    .select({
      hostname: tailscaleConfig.hostname,
      masked: tailscaleConfig.masked,
      lastActivatedAt: tailscaleConfig.lastActivatedAt,
    })
    .from(tailscaleConfig)
    .where(eq(tailscaleConfig.ownerId, ownerId))
    .limit(1);
  return row ?? null;
}

/** Decrypt the stored auth key for server-side use (driving tailscaled login).
 *  Returns null when no key is configured. */
export async function getTailscaleAuthKey(ownerId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: tailscaleConfig.id, authKeyEnc: tailscaleConfig.authKeyEnc })
    .from(tailscaleConfig)
    .where(eq(tailscaleConfig.ownerId, ownerId))
    .limit(1);
  if (!row) return null;
  return open(row.authKeyEnc, row.id); // AAD = row id
}

/** Save (or replace) the owner's key + hostname. On replace we re-seal under the
 *  EXISTING row id (the AAD), like rotateApiKey — never a fresh-UUID upsert. */
export async function setTailscaleConfig(
  ownerId: string,
  authKey: string,
  hostname: string,
): Promise<TailscaleConfigSummary> {
  const masked = maskPlaintext(authKey);
  const [existing] = await db
    .select({ id: tailscaleConfig.id })
    .from(tailscaleConfig)
    .where(eq(tailscaleConfig.ownerId, ownerId))
    .limit(1);

  if (existing) {
    const { ciphertext, keyVersion } = seal(authKey, existing.id);
    await db
      .update(tailscaleConfig)
      .set({ authKeyEnc: ciphertext, keyVersion, hostname, masked, updatedAt: new Date() })
      .where(eq(tailscaleConfig.id, existing.id));
  } else {
    const id = randomUUID();
    const { ciphertext, keyVersion } = seal(authKey, id);
    await db
      .insert(tailscaleConfig)
      .values({ id, ownerId, authKeyEnc: ciphertext, keyVersion, hostname, masked });
  }
  return { hostname, masked, lastActivatedAt: null };
}

/** Stamp last_activated_at after a successful activation. */
export async function markTailscaleActivated(ownerId: string): Promise<void> {
  await db
    .update(tailscaleConfig)
    .set({ lastActivatedAt: new Date() })
    .where(eq(tailscaleConfig.ownerId, ownerId));
}

/** Forget the stored key + hostname entirely. */
export async function clearTailscaleConfig(ownerId: string): Promise<void> {
  await db.delete(tailscaleConfig).where(eq(tailscaleConfig.ownerId, ownerId));
}
