// POST /api/push/connect — the one-tap Connect entrypoint (push-notifications.md
// §5.1). Lazily generates + registers this install's instance token with the
// relay (first time only), then mints a short-lived enrollment ticket bound to
// the calling device's OS push token. The app takes the ticket to the relay's
// /enroll, then posts the routing token back to /api/push/subscriptions.

import { type NextRequest, NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { generateInstanceToken } from '@/lib/push/tokens';
import { mintTicket } from '@/lib/push/ticket';
import { registerInstance } from '@/lib/push/relay-client';
import { getPushInstance, savePushInstance } from '@/lib/push/store';

const DEFAULT_RELAY_URL = 'https://push.crossworks.network';

export async function POST(req: NextRequest) {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;

  const body = (await req.json().catch(() => null)) as {
    platform?: unknown;
    osPushToken?: unknown;
  } | null;
  const platform = body?.platform;
  const osPushToken = body?.osPushToken;
  if (
    (platform !== 'ios' && platform !== 'android') ||
    typeof osPushToken !== 'string' ||
    !osPushToken
  ) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  // Lazily register this install with the relay (TOFU) the first time.
  let instance = await getPushInstance();
  if (!instance) {
    const relayUrl = process.env.MANTLE_PUSH_RELAY_URL ?? DEFAULT_RELAY_URL;
    const instanceToken = generateInstanceToken();
    try {
      const { instanceId } = await registerInstance(relayUrl, instanceToken);
      await savePushInstance({ instanceToken, relayInstanceId: instanceId, relayUrl });
      instance = { instanceToken, relayInstanceId: instanceId, relayUrl };
    } catch (err) {
      return NextResponse.json(
        { error: 'relay_unreachable', reason: (err as Error).message },
        { status: 502 },
      );
    }
  }

  const ticket = mintTicket({
    iid: instance.relayInstanceId,
    osPushToken,
    instanceToken: instance.instanceToken,
  });
  return NextResponse.json({ ticket, relayUrl: instance.relayUrl });
}
