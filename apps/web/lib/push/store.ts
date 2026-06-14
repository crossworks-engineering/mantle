// Data access for push state. The instance token is sealed at rest with
// @mantle/crypto (AES-256-GCM under the master key); subscriptions hold the
// relay's routing token + the device's public key.

import { and, eq } from 'drizzle-orm';
import { db, pushInstance, pushSubscriptions } from '@mantle/db';
import { open, seal } from '@mantle/crypto';

export interface PushInstanceSecret {
  instanceToken: string;
  relayInstanceId: string;
  relayUrl: string;
}

/** The single relay-identity row with the instance token decrypted, or null. */
export async function getPushInstance(): Promise<PushInstanceSecret | null> {
  const [row] = await db.select().from(pushInstance).limit(1);
  if (!row) return null;
  return {
    instanceToken: open(Buffer.from(row.instanceTokenEnc, 'base64')),
    relayInstanceId: row.relayInstanceId,
    relayUrl: row.relayUrl,
  };
}

/** Public status (no secret) for settings UI. */
export async function getPushInstanceMeta(): Promise<{ relayUrl: string; connectedAt: Date } | null> {
  const [row] = await db
    .select({ relayUrl: pushInstance.relayUrl, connectedAt: pushInstance.connectedAt })
    .from(pushInstance)
    .limit(1);
  return row ?? null;
}

/** Upsert the singleton relay identity (encrypts the instance token). */
export async function savePushInstance(args: PushInstanceSecret): Promise<void> {
  const instanceTokenEnc = seal(args.instanceToken).ciphertext.toString('base64');
  await db
    .insert(pushInstance)
    .values({
      instanceTokenEnc,
      relayInstanceId: args.relayInstanceId,
      relayUrl: args.relayUrl,
      singleton: true,
    })
    .onConflictDoUpdate({
      target: pushInstance.singleton,
      set: { instanceTokenEnc, relayInstanceId: args.relayInstanceId, relayUrl: args.relayUrl, connectedAt: new Date() },
    });
}

export interface DeviceRow {
  id: string;
  routingToken: string;
  publicKey: string;
  platform: 'ios' | 'android';
  label: string | null;
}

export async function listSubscriptions(ownerId: string): Promise<DeviceRow[]> {
  const rows = await db
    .select({
      id: pushSubscriptions.id,
      routingToken: pushSubscriptions.routingToken,
      publicKey: pushSubscriptions.publicKey,
      platform: pushSubscriptions.platform,
      label: pushSubscriptions.label,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.ownerId, ownerId));
  return rows as DeviceRow[];
}

export async function insertSubscription(args: {
  ownerId: string;
  routingToken: string;
  publicKey: string;
  platform: 'ios' | 'android';
  label?: string | null;
  relayDeviceId?: string | null;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      ownerId: args.ownerId,
      routingToken: args.routingToken,
      publicKey: args.publicKey,
      platform: args.platform,
      label: args.label ?? null,
      relayDeviceId: args.relayDeviceId ?? null,
    })
    .returning({ id: pushSubscriptions.id });
  return row!;
}

/** Delete one device (scoped to owner); returns its routing token for relay cleanup. */
export async function deleteSubscription(ownerId: string, id: string): Promise<string | null> {
  const [row] = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.ownerId, ownerId)))
    .returning({ routingToken: pushSubscriptions.routingToken });
  return row?.routingToken ?? null;
}

/** Delete all of an owner's devices (used by reset); returns their routing tokens. */
export async function deleteAllSubscriptions(ownerId: string): Promise<string[]> {
  const rows = await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.ownerId, ownerId))
    .returning({ routingToken: pushSubscriptions.routingToken });
  return rows.map((r) => r.routingToken);
}

/** Drop a device by routing token (worker cleanup on a 410 from the relay). */
export async function deleteSubscriptionByRoutingToken(routingToken: string): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.routingToken, routingToken));
}

export async function markPushed(id: string): Promise<void> {
  await db.update(pushSubscriptions).set({ lastPushAt: new Date() }).where(eq(pushSubscriptions.id, id));
}
