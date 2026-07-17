// POST /api/push/reset — roll the instance token (push-notifications.md §5.3),
// e.g. after a suspected leak. Registers a fresh instance with the relay and
// invalidates every existing subscription; devices must re-Connect. Old relay
// device rows become unreachable (no one holds the old instance token).

import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { generateInstanceToken } from '@/lib/push/tokens';
import { registerInstance } from '@/lib/push/relay-client';
import { deleteAllSubscriptions, getPushInstance, savePushInstance } from '@/lib/push/store';

const DEFAULT_RELAY_URL = 'https://push.crossworks.network';

export async function POST() {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;

  const existing = await getPushInstance();
  const relayUrl = existing?.relayUrl ?? process.env.MANTLE_PUSH_RELAY_URL ?? DEFAULT_RELAY_URL;
  const instanceToken = generateInstanceToken();
  try {
    const { instanceId } = await registerInstance(relayUrl, instanceToken);
    await savePushInstance({ instanceToken, relayInstanceId: instanceId, relayUrl });
  } catch (err) {
    return NextResponse.json(
      { error: 'relay_unreachable', reason: (err as Error).message },
      { status: 502 },
    );
  }

  const invalidated = await deleteAllSubscriptions(owner.id);
  return NextResponse.json({ ok: true, invalidated: invalidated.length });
}
