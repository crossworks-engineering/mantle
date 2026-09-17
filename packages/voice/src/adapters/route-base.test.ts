/** Per-route base URL reaches the wire on the native-fetch adapters (2026-09-02
 *  audit, gap D4: it used to be accepted and silently dropped). */
import { afterEach, describe, expect, it } from 'vitest';
import { anthropicChatAdapter } from './anthropic-chat';
import { googleChatAdapter } from './google-chat';
import { routeBase } from './sse';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureFetch(body: unknown) {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return urls;
}

describe('routeBase', () => {
  it('prefers the override, trims slashes, falls back', () => {
    expect(routeBase(' https://proxy.local/v1/// ', 'https://api.x')).toBe(
      'https://proxy.local/v1',
    );
    expect(routeBase('', 'https://api.x')).toBe('https://api.x');
    expect(routeBase(undefined, 'https://api.x')).toBe('https://api.x');
  });
});

describe('per-route baseUrl on the native adapters', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }];
  it('anthropic hits the route base URL', async () => {
    const urls = captureFetch({ content: [{ type: 'text', text: 'ok' }], model: 'm', usage: {} });
    await anthropicChatAdapter.chat({
      apiKey: 'k',
      model: 'm',
      messages,
      baseUrl: 'https://tailnet-box:8443/',
    });
    expect(urls[0]).toBe('https://tailnet-box:8443/v1/messages');
  });
  it('google hits the route base URL', async () => {
    const urls = captureFetch({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    await googleChatAdapter.chat({
      apiKey: 'k',
      model: 'gemini',
      messages,
      baseUrl: 'https://gw.local/v1beta',
    });
    expect(urls[0]).toBe('https://gw.local/v1beta/models/gemini:generateContent');
  });
});
