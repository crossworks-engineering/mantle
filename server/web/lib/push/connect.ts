// The Connect step shared by the three roles' connect routes
// (push-notifications.md §5.1): make sure this install is registered with
// the relay, then mint a short-lived enrollment ticket bound to the calling
// device's OS push token.

import { env } from '@mantle/config';
import { generateInstanceToken } from './tokens';
import { mintTicket } from './ticket';
import { registerInstance } from './relay-client';
import { getPushInstance, savePushInstance } from './store';

export const DEFAULT_RELAY_URL = 'https://push.crossworks.network';

export type ConnectBody = { platform: 'ios' | 'android'; osPushToken: string };

/** The body of a connect request, or null when it is not one. */
export function parseConnectBody(body: unknown): ConnectBody | null {
  const b = (body ?? {}) as { platform?: unknown; osPushToken?: unknown };
  if (
    (b.platform !== 'ios' && b.platform !== 'android') ||
    typeof b.osPushToken !== 'string' ||
    !b.osPushToken
  ) {
    return null;
  }
  return { platform: b.platform, osPushToken: b.osPushToken };
}

export type ConnectResult =
  | { ok: true; ticket: string; relayUrl: string }
  | { ok: false; error: 'push_not_set_up' }
  | { ok: false; error: 'relay_unreachable'; reason: string };

/**
 * Mint an enrollment ticket for `osPushToken`. The first Connect on a brain
 * registers the install with the relay (trust on first use). `mayRegister`
 * says whether THIS caller may be the one to do that: an admin or a member
 * (the brain's own people) may; a client (an outside party) may not, and
 * gets `push_not_set_up` until one of them has connected once.
 */
export async function connectDevice(
  osPushToken: string,
  opts: { mayRegister: boolean },
): Promise<ConnectResult> {
  let instance = await getPushInstance();
  if (!instance) {
    if (!opts.mayRegister) return { ok: false, error: 'push_not_set_up' };
    const relayUrl = env('MANTLE_PUSH_RELAY_URL') ?? DEFAULT_RELAY_URL;
    const instanceToken = generateInstanceToken();
    try {
      const { instanceId } = await registerInstance(relayUrl, instanceToken);
      await savePushInstance({ instanceToken, relayInstanceId: instanceId, relayUrl });
      instance = { instanceToken, relayInstanceId: instanceId, relayUrl };
    } catch (err) {
      return { ok: false, error: 'relay_unreachable', reason: (err as Error).message };
    }
  }
  const ticket = mintTicket({
    iid: instance.relayInstanceId,
    osPushToken,
    instanceToken: instance.instanceToken,
  });
  return { ok: true, ticket, relayUrl: instance.relayUrl };
}
