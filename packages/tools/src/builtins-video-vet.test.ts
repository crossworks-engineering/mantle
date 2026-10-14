/**
 * The video link's redirect walk fails closed (A10 part 1 fix round 1): a
 * link that redirects more than the walk follows, or does not answer
 * within the deadline, is refused before the media sidecar sees it, since
 * the hops the sidecar would follow were never checked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  'node:dns/promises',
  async () => (await import('@mantle/std/egress-test-net')).testNetDnsModule,
);

import { createTestNet, useTestNet } from '@mantle/std/egress-test-net';
import { vetVideoUrl } from './builtins-video';

afterEach(() => {
  useTestNet(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function install(hosts: Parameters<typeof createTestNet>[0]) {
  const net = createTestNet(hosts);
  useTestNet(net);
  vi.stubGlobal('fetch', net.fetch);
  return net;
}

describe('vetVideoUrl', () => {
  it('refuses a link that redirects more than the walk follows', async () => {
    const net = install({
      'loop.test': { ip: '93.184.216.60', reply: { kind: 'redirect', to: 'https://loop.test/' } },
    });
    expect(await vetVideoUrl('https://loop.test/watch')).toMatch(
      /^too many redirects \(>5\): the link's redirects could not all be checked$/,
    );
    expect(net.log).toHaveLength(6);
  });

  it('refuses a link that does not answer within the deadline', async () => {
    install({ 'slow.test': { ip: '93.184.216.61', reply: { kind: 'hang' } } });
    vi.useFakeTimers();
    const p = vetVideoUrl('https://slow.test/watch');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await p).toBe(
      'the link did not answer within 10 s, so its redirects could not be checked',
    );
  });

  it('hands an answering public link on', async () => {
    install({
      'ok.test': {
        ip: '93.184.216.62',
        reply: { kind: 'ok', body: 'x', contentType: 'text/html' },
      },
    });
    expect(await vetVideoUrl('https://ok.test/watch')).toBeNull();
  });
});
