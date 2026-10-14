/**
 * The image URL in xAI's answer goes through the one egress fetch (A10
 * part 1 fix round 1): a URL into metadata or private space is refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  'node:dns/promises',
  async () => (await import('@mantle/std/egress-test-net')).testNetDnsModule,
);

import { useTestNet, createTestNet } from '@mantle/std/egress-test-net';
import { xaiImageAdapter } from './xai-image';

afterEach(() => {
  useTestNet(null);
  vi.unstubAllGlobals();
});

function answerWithUrl(url: string): string[] {
  const asked: string[] = [];
  const net = createTestNet({
    'img.test': {
      ip: '93.184.216.70',
      reply: { kind: 'ok', body: 'PNG', contentType: 'image/png' },
    },
  });
  useTestNet(net);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    asked.push(new URL(u).hostname);
    if (u.endsWith('/images/generations')) {
      return new Response(JSON.stringify({ data: [{ url }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return net.fetch(input, init);
  });
  return asked;
}

describe('xai-image returned URL', () => {
  it('refuses a returned URL into the metadata range', async () => {
    const asked = answerWithUrl('http://169.254.169.254/latest/meta-data/');
    await expect(
      xaiImageAdapter.generate({ apiKey: 'k', prompt: 'a cat' } as never),
    ).rejects.toThrow(/private\/internal address/);
    expect(asked).toEqual(['api.x.ai']);
  });

  it('fetches a public returned URL', async () => {
    answerWithUrl('https://img.test/a.png');
    const r = await xaiImageAdapter.generate({ apiKey: 'k', prompt: 'a cat' } as never);
    expect(r.bytes.toString()).toBe('PNG');
    expect(r.mimeType).toBe('image/png');
  });
});
