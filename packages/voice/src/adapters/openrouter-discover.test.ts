/**
 * OpenRouter discovery auth-probe lock-down. OR's /api/v1/models is PUBLIC
 * (200 even with a garbage key), so discovery must validate the key against
 * GET /api/v1/key first — otherwise probeApiKey ("discovery = auth probe")
 * reports a wrong key as working, which is exactly the bug this pins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { openrouterChatAdapter } from './openrouter-chat';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CATALOG = {
  data: [
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    },
  ],
};

function routeFetch(keyStatus: number) {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith('/key')) {
      return {
        ok: keyStatus < 400,
        status: keyStatus,
        json: async () => ({}),
        text: async () => '',
      };
    }
    return { ok: true, status: 200, json: async () => CATALOG, text: async () => '' };
  }) as unknown as typeof fetch;
  return urls;
}

describe('openrouter discovery auth probe', () => {
  it('rejects a bad key via /api/v1/key instead of false-passing on the public catalog', async () => {
    const urls = routeFetch(401);
    const res = await openrouterChatAdapter.discoverModels!('sk-or-bogus');
    expect(urls.some((u) => u.endsWith('/key'))).toBe(true);
    expect(res.error).toMatch(/rejected the key \(401\)/);
    expect(res.available).toHaveLength(0);
  });

  it('passes a valid key through to the catalog', async () => {
    const urls = routeFetch(200);
    const res = await openrouterChatAdapter.discoverModels!('sk-or-good');
    expect(urls.some((u) => u.endsWith('/key'))).toBe(true);
    expect(res.error ?? null).toBeNull();
    expect(res.available.length).toBeGreaterThan(0);
  });
});
