// The send path: given an outbound conversation turn (or a pending approval),
// seal a teaser to each of the owner's devices and hand it to the relay —
// gated by the owner's per-trigger toggles (push-notifications.md §10). Quiet
// hours were removed (docs/reminder-delivery-routing.md §C); OS-level Do Not
// Disturb handles night muting. Pure server logic, shared by the push-notify
// worker. Content never leaves here unsealed.

import { and, desc, eq } from 'drizzle-orm';
import { db, agents, assistantMessages } from '@mantle/db';
import { countPending } from '@mantle/tools';
import { loadProfilePreferences } from '@mantle/content';
import { sealToDevice } from './seal';
import { relayNotify } from './relay-client';
import {
  deleteSubscriptionByRoutingToken,
  getPushInstance,
  getPushPrefs,
  listSubscriptions,
  markPushed,
  type DeviceRow,
  type PushInstanceSecret,
} from './store';

/** The plaintext that gets sealed to the device (push-notifications.md §6). */
interface PushPayload {
  v: 1;
  t: string; // title (agent name, or "Mantle")
  b: string; // body (teaser)
  agentSlug?: string;
  deepLink: string;
  ts: number;
}

export interface PushResult {
  attempted: number;
  delivered: number;
  dropped: number; // unregistered devices removed
  skipped?: 'not_connected' | 'no_devices' | 'no_message' | 'disabled' | 'wrong_channel';
}

function teaser(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

async function latestOutbound(
  ownerId: string,
  agentSlug: string,
): Promise<{ agentName: string; text: string } | null> {
  const [agent] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, agentSlug)))
    .limit(1);
  if (!agent) return null;

  const [msg] = await db
    .select({ text: assistantMessages.text })
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.ownerId, ownerId),
        eq(assistantMessages.agentId, agent.id),
        eq(assistantMessages.direction, 'outbound'),
      ),
    )
    .orderBy(desc(assistantMessages.createdAt))
    .limit(1);
  if (!msg) return null;
  return { agentName: agent.name, text: msg.text };
}

/** Seal `payload` to each device and forward to the relay. Prunes dead devices. */
async function sendToDevices(
  instance: PushInstanceSecret,
  devices: DeviceRow[],
  payload: PushPayload,
  collapseKey: string,
): Promise<{ delivered: number; dropped: number }> {
  const plaintext = JSON.stringify(payload);
  let delivered = 0;
  let dropped = 0;
  for (const device of devices) {
    let ciphertext: string;
    try {
      ciphertext = await sealToDevice(device.publicKey, plaintext);
    } catch {
      continue; // a bad public key shouldn't break the others
    }
    const res = await relayNotify(instance.relayUrl, instance.instanceToken, {
      routingToken: device.routingToken,
      ciphertext,
      collapseKey,
    });
    if (res.ok) {
      delivered++;
      void markPushed(device.id);
    } else if (res.unregistered) {
      dropped++;
      await deleteSubscriptionByRoutingToken(device.routingToken);
    }
  }
  return { delivered, dropped };
}

/**
 * Push the latest outbound turn for {ownerId, agentSlug} to every enrolled
 * device — unless the assistant-messages trigger is off.
 */
export async function pushOutbound(ownerId: string, agentSlug: string): Promise<PushResult> {
  const instance = await getPushInstance();
  if (!instance) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'not_connected' };

  const prefs = await getPushPrefs();
  if (!prefs.assistantMessages) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'disabled' };

  const devices = await listSubscriptions(ownerId);
  if (devices.length === 0) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'no_devices' };

  const msg = await latestOutbound(ownerId, agentSlug);
  if (!msg) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'no_message' };

  const payload: PushPayload = {
    v: 1,
    t: msg.agentName,
    b: teaser(msg.text),
    agentSlug,
    deepLink: `/chat/${agentSlug}`,
    ts: Date.now(),
  };
  const { delivered, dropped } = await sendToDevices(instance, devices, payload, agentSlug);
  return { attempted: devices.length, delivered, dropped };
}

/**
 * Push a pending-approval nudge to the owner's devices — unless the approvals
 * trigger is off, or the operator's last communication channel isn't the
 * companion app. Approvals follow `reminderChannel` (the sticky last-channel
 * signal, see docs/reminder-delivery-routing.md): a `telegram`/unset operator
 * gets the one-tap Telegram card instead (pending-notify.ts), so pushing here
 * too would double-notify. Only the `mobile` channel routes to a device push.
 * Collapses on "approvals" so repeated nudges supersede.
 */
export async function pushApproval(ownerId: string): Promise<PushResult> {
  const instance = await getPushInstance();
  if (!instance) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'not_connected' };

  const prefs = await getPushPrefs();
  if (!prefs.approvals) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'disabled' };

  const profile = await loadProfilePreferences(ownerId);
  if (profile.reminderChannel !== 'mobile') {
    return { attempted: 0, delivered: 0, dropped: 0, skipped: 'wrong_channel' };
  }

  const devices = await listSubscriptions(ownerId);
  if (devices.length === 0) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'no_devices' };

  const count = await countPending(ownerId);
  if (count === 0) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'no_message' };

  const payload: PushPayload = {
    v: 1,
    t: 'Mantle',
    b: count === 1 ? 'An action needs your approval.' : `${count} actions need your approval.`,
    deepLink: '/pending',
    ts: Date.now(),
  };
  const { delivered, dropped } = await sendToDevices(instance, devices, payload, 'approvals');
  return { attempted: devices.length, delivered, dropped };
}
