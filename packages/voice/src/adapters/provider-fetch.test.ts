import { once } from 'node:events';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_CONNECTIONS,
  _resetProviderDispatcher,
  providerDispatcher,
  providerFetch,
} from './provider-fetch';

/**
 * The regression guard for the serial-fetch limit (docs/provider-http.md).
 *
 * Node 26's built-in fetch, on a warm HTTP/2 session, sent POSTs one at a
 * time: N parallel provider calls took N request times. This test serves a
 * slow endpoint over TLS with HTTP/2 offered (as a provider does), warms the
 * pool, then sends N POSTs at once through providerFetch. Side by side they
 * finish in about one request time; one at a time they take N.
 */

// A self-signed certificate for localhost, valid to 2126, used only here.
const KEY = `
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtkWvBsMal7Qv9H5p
xvSblGxLDngWr6s7AgNoPY6N1IehRANCAAQatR8htwAjfHjMwe7w6I3Y5alxWXYS
iRVHFg49mB4ul8PwDwesjHSBb0h/ZfGXXInSVwtV2jHpSL3z7O/Y9LCb
-----END PRIVATE KEY-----
`;
const CERT = `
-----BEGIN CERTIFICATE-----
MIIBmjCCAUGgAwIBAgIUGkMp4J9Bn0y7rkH4NgSQLiXXTcUwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAwNDEwMDMzM1oYDzIxMjYwOTEw
MTAwMzMzWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQatR8htwAjfHjMwe7w6I3Y5alxWXYSiRVHFg49mB4ul8PwDwesjHSB
b0h/ZfGXXInSVwtV2jHpSL3z7O/Y9LCbo28wbTAdBgNVHQ4EFgQUpmMIgyZhOqu0
7uupWfZI5hSpr44wHwYDVR0jBBgwFoAUpmMIgyZhOqu07uupWfZI5hSpr44wDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDRwAwRAIgAo+jWGQoxtN0j01aqVvSWPoXsILPLMDOJxDe8AtvyNgCIC4y
Rdq+4rPafZ9zenW2XsKD8ohIFfBgfwfZEcf564xV
-----END CERTIFICATE-----
`;

const DELAY_MS = 200;
const N = 8;

let server: http2.Http2SecureServer;
let url = '';

beforeAll(async () => {
  server = http2.createSecureServer({ key: KEY, cert: CERT, allowHTTP1: true }, (req, res) => {
    req.resume();
    req.on('end', () =>
      setTimeout(() => res.end(JSON.stringify({ v: req.httpVersion })), DELAY_MS),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `https://localhost:${(server.address() as AddressInfo).port}/v1/embeddings`;
});

afterAll(async () => {
  _resetProviderDispatcher();
  server.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function post(): Promise<Response> {
  return providerFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'x'.repeat(1000) }),
  });
}

describe('providerFetch', () => {
  it('sends parallel POSTs to one origin side by side, not one at a time', async () => {
    _resetProviderDispatcher(CERT);
    // Warm the pool: the serial limit only showed on a warm connection.
    await Promise.all(Array.from({ length: N }, () => post().then((r) => r.text())));

    const t0 = performance.now();
    const res = await Promise.all(Array.from({ length: N }, () => post()));
    const bodies = await Promise.all(res.map((r) => r.json() as Promise<{ v: string }>));
    const elapsed = performance.now() - t0;

    expect(res.every((r) => r.ok && r instanceof Response)).toBe(true);
    expect(bodies[0]!.v).toBe('1.1');
    // One at a time would be N * DELAY_MS (1.6 s). Side by side is about one
    // DELAY_MS; allow three for a busy CI box.
    expect(elapsed).toBeLessThan(DELAY_MS * 3);
  });

  it('keeps one shared pool for the process', () => {
    _resetProviderDispatcher();
    const a = providerDispatcher();
    expect(a).not.toBeNull();
    expect(providerDispatcher()).toBe(a);
    expect(PROVIDER_CONNECTIONS).toBeGreaterThanOrEqual(N);
  });

  it('lets a replaced global fetch (a test stub) win, untouched', async () => {
    const stub = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', stub);
    const init = { method: 'POST', body: '{}' };
    await providerFetch('https://example.invalid/v1/chat/completions', init);
    expect(stub).toHaveBeenCalledWith('https://example.invalid/v1/chat/completions', init);
  });
});
