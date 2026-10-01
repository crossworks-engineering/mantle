// The relay client's failure handling: every call has a timeout (a relay
// that hangs must not hold the send chain), and a device the relay does not
// know is reported as gone so the caller prunes it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELAY_TIMEOUT_MS, relayDeleteDevice, relayNotify, registerInstance } from './relay-client';

const URL = 'https://relay.example.invalid';
const args = { routingToken: 'r', ciphertext: 'c', collapseKey: 'k' };

afterEach(() => {
  vi.unstubAllGlobals();
});

const respond = (status: number, body: unknown = {}) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );

describe('relay client', () => {
  it('gives every call a timeout signal', async () => {
    const fetchMock = respond(200, { instanceId: 'i' });
    vi.stubGlobal('fetch', fetchMock);
    await relayNotify(URL, 't', args);
    await relayDeleteDevice(URL, 't', 'r');
    await registerInstance(URL, 't');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
    expect(RELAY_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it('a call that times out or fails is a failed send, never a throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );
    const res = await relayNotify(URL, 't', args);
    expect(res).toMatchObject({ ok: false, status: 0 });
    expect(res.unregistered).toBeUndefined();
    expect(await relayDeleteDevice(URL, 't', 'r')).toBe(false);
  });

  it('reports a device gone only when the relay says so (410, or 404 unknown_device)', async () => {
    // The relay's own answers (mantle-push src/app.ts, POST /notify): 410
    // device_unregistered when the provider dropped it, 404 unknown_device
    // when it has no such routing token.
    vi.stubGlobal('fetch', respond(410, { error: 'device_unregistered', reason: 'x' }));
    expect(await relayNotify(URL, 't', args)).toMatchObject({ ok: false, unregistered: true });
    vi.stubGlobal('fetch', respond(404, { error: 'unknown_device' }));
    expect(await relayNotify(URL, 't', args)).toMatchObject({ ok: false, unregistered: true });
    // A 404 that is not the relay's (a proxy, a wrong relay URL, an HTML
    // page) says nothing about the device: kept.
    vi.stubGlobal('fetch', respond(404, { error: 'not_found' }));
    expect(await relayNotify(URL, 't', args)).toMatchObject({ ok: false, unregistered: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Not Found</html>', { status: 404 })),
    );
    expect(await relayNotify(URL, 't', args)).toMatchObject({ ok: false, unregistered: false });
    // Any other failure keeps the device (the relay may be back in a minute).
    for (const status of [429, 500, 503]) {
      vi.stubGlobal('fetch', respond(status, { error: 'busy' }));
      expect(await relayNotify(URL, 't', args)).toMatchObject({ ok: false, unregistered: false });
    }
  });
});
