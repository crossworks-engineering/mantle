import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tailnetFetch, tailnetProxyConfigured, _resetTailnetProxy } from './tailnet';

/**
 * Selection-logic coverage. The end-to-end NAT traversal needs a live tailnet
 * to verify — here we only assert WHICH path tailnetFetch takes:
 *   - no proxy configured  → a normal direct fetch (degrade, never crash)
 *   - proxy configured     → the request goes through the proxy (a local
 *                            CONNECT proxy stands in for the Tailscale one)
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.MANTLE_TAILNET_PROXY_URL;
  _resetTailnetProxy();
});
beforeEach(() => {
  delete process.env.MANTLE_TAILNET_PROXY_URL;
  _resetTailnetProxy();
});

describe('tailnetProxyConfigured', () => {
  it('reflects MANTLE_TAILNET_PROXY_URL', () => {
    expect(tailnetProxyConfigured()).toBe(false);
    process.env.MANTLE_TAILNET_PROXY_URL = 'http://tailscale:1055';
    expect(tailnetProxyConfigured()).toBe(true);
  });
});

describe('tailnetFetch', () => {
  it('degrades to a DIRECT fetch when no proxy is configured', async () => {
    let calledWith: { url: string; init?: unknown } | null = null;
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      calledWith = { url: String(url), init };
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;

    await tailnetFetch('http://gpu-box:11434/v1/x', { method: 'POST' });
    expect(calledWith).not.toBeNull();
    expect(calledWith!.url).toBe('http://gpu-box:11434/v1/x');
  });

  it('fails loudly, not direct, when a configured proxy is down', async () => {
    process.env.MANTLE_TAILNET_PROXY_URL = 'http://127.0.0.1:1'; // nothing listening
    _resetTailnetProxy();
    // Routed through undici's ProxyAgent → tries to reach the proxy, which isn't
    // listening, so it rejects instead of quietly going direct.
    await expect(tailnetFetch('http://gpu-box:11434/v1/x', { method: 'POST' })).rejects.toThrow();
  });

  it('sends the request through the configured proxy (ESM, no bare require)', async () => {
    // The model host the proxy reaches.
    const target = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => res.end(JSON.stringify({ path: req.url, method: req.method })));
    });
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    const targetPort = (target.address() as AddressInfo).port;

    // A forward proxy, like Tailscale's outbound HTTP proxy: plain requests
    // with an absolute URL, and CONNECT tunnels.
    const seen: string[] = [];
    const proxy = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const up = http.request(req.url!, { method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.writeHead(502).end());
      req.pipe(up);
    });
    proxy.on('connect', (req, client, head) => {
      seen.push(`CONNECT ${req.url}`);
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');

    try {
      process.env.MANTLE_TAILNET_PROXY_URL = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      _resetTailnetProxy();
      const res = await tailnetFetch(`http://127.0.0.1:${targetPort}/v1/chat/completions`, {
        method: 'POST',
        body: '{}',
      });
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({ path: '/v1/chat/completions', method: 'POST' });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(`127.0.0.1:${targetPort}`);
    } finally {
      _resetTailnetProxy();
      proxy.closeAllConnections();
      target.closeAllConnections();
      proxy.close();
      target.close();
    }
  });
});

describe('no bare require in the voice adapters', () => {
  // The server runs as ESM, where `require` does not exist, but vitest supplies
  // one, so a bare `require('undici')` passed every test here and still threw
  // "require is not defined" in the brain the moment a tailnet proxy was set.
  // Node-only modules load through provider-fetch.ts's loadUndici() instead.
  it('has no require( call outside tests', () => {
    const dir = new URL('.', import.meta.url);
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /(^|[^.\w])require\(/m.test(readFileSync(new URL(f, dir), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
