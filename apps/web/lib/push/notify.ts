// The send path: given an outbound conversation turn, seal a teaser to each of
// the owner's devices and hand it to the relay. Pure server logic, shared by the
// push-notify worker. Content never leaves here unsealed.

import { and, desc, eq } from 'drizzle-orm';
import { db, agents, assistantMessages } from '@mantle/db';
import { sealToDevice } from './seal';
import { relayNotify } from './relay-client';
import {
  deleteSubscriptionByRoutingToken,
  getPushInstance,
  listSubscriptions,
  markPushed,
} from './store';

/** The plaintext that gets sealed to the device (push-notifications.md §6). */
interface PushPayload {
  v: 1;
  t: string; // title (agent name)
  b: string; // body (teaser)
  agentSlug: string;
  deepLink: string;
  ts: number;
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

export interface PushOutboundResult {
  attempted: number;
  delivered: number;
  dropped: number; // unregistered devices removed
  skipped?: 'not_connected' | 'no_devices' | 'no_message';
}

/**
 * Push the latest outbound turn for {ownerId, agentSlug} to every enrolled
 * device. Best-effort: a per-device failure never throws; a dead device (410)
 * is pruned. Returns a small tally for logging.
 */
export async function pushOutbound(ownerId: string, agentSlug: string): Promise<PushOutboundResult> {
  const instance = await getPushInstance();
  if (!instance) return { attempted: 0, delivered: 0, dropped: 0, skipped: 'not_connected' };

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
      collapseKey: agentSlug, // supersede repeated nudges from the same agent
    });
    if (res.ok) {
      delivered++;
      void markPushed(device.id);
    } else if (res.unregistered) {
      dropped++;
      await deleteSubscriptionByRoutingToken(device.routingToken);
    }
  }
  return { attempted: devices.length, delivered, dropped };
}
