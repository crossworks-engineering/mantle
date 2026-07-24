// Thin client for Mantle → Mantle Push (the relay). Mantle authenticates with
// its instance token; the relay forwards ciphertext to APNs/FCM. See
// mantle-push/README.md for the endpoint contract.

export interface RelayNotifyResult {
  ok: boolean;
  status: number;
  /** The device's OS push token is dead (410) — drop the subscription. */
  unregistered?: boolean;
  reason?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** TOFU register/claim this install. Returns the relay's instance id. */
export async function registerInstance(
  relayUrl: string,
  instanceToken: string,
): Promise<{ instanceId: string }> {
  const res = await fetch(`${relayUrl}/instances`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ instanceToken }),
  });
  if (!res.ok) {
    throw new Error(`relay /instances failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as { instanceId: string };
}

/** Forward one sealed payload to a device (by routing token). */
export async function relayNotify(
  relayUrl: string,
  instanceToken: string,
  args: {
    routingToken: string;
    ciphertext: string;
    collapseKey?: string;
    priority?: 'high' | 'normal';
  },
): Promise<RelayNotifyResult> {
  let res: Response;
  try {
    res = await fetch(`${relayUrl}/notify`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${instanceToken}` },
      body: JSON.stringify(args),
    });
  } catch (err) {
    return { ok: false, status: 0, reason: (err as Error).message };
  }
  if (res.ok) return { ok: true, status: res.status };
  let reason: string | undefined;
  try {
    const j = (await res.json()) as { reason?: string; error?: string };
    reason = j.reason ?? j.error;
  } catch {
    /* non-JSON */
  }
  return { ok: false, status: res.status, unregistered: res.status === 410, reason };
}

/** Unpair a device on the relay (instance-token auth). */
export async function relayDeleteDevice(
  relayUrl: string,
  instanceToken: string,
  routingToken: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${relayUrl}/device`, {
      method: 'DELETE',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${instanceToken}` },
      body: JSON.stringify({ routingToken }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
