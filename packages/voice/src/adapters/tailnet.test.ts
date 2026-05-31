import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tailnetFetch, tailnetProxyConfigured, _resetTailnetProxy } from './tailnet';

/**
 * Selection-logic coverage. The end-to-end NAT traversal needs a live tailnet
 * to verify — here we only assert WHICH path tailnetFetch takes:
 *   - no proxy configured  → a normal direct fetch (degrade, never crash)
 *   - proxy configured     → does NOT use the direct global fetch (it dispatches
 *                            through undici's ProxyAgent toward the proxy)
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

  it('does NOT use the direct global fetch when a proxy IS configured', async () => {
    process.env.MANTLE_TAILNET_PROXY_URL = 'http://127.0.0.1:1'; // nothing listening
    _resetTailnetProxy();
    let directCalled = false;
    globalThis.fetch = (async () => {
      directCalled = true;
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;

    // Routed through undici's ProxyAgent → tries to reach the proxy, which isn't
    // listening, so it rejects. The point: the DIRECT fetch was bypassed.
    await expect(tailnetFetch('http://gpu-box:11434/v1/x', { method: 'POST' })).rejects.toThrow();
    expect(directCalled).toBe(false);
  });
});
