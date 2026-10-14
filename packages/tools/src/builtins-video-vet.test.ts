/**
 * The video link's redirect walk fails closed (A10 part 1 fix rounds 1 and
 * 2): a link that redirects more than the walk follows, does not answer
 * within the deadline, redirects to a Location that is no URL, or fails
 * after its first hop is refused before the media sidecar sees it, since
 * the hops the sidecar would follow were never checked. The sidecar gets
 * the URL parser's canonical form of the link.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  'node:dns/promises',
  async () => (await import('@mantle/std/egress-test-net')).testNetDnsModule,
);

import { createTestNet, useTestNet } from '@mantle/std/egress-test-net';
import { vetVideoUrl, walkVideoUrl } from './builtins-video';

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

  /** DNS from the test net; each host's answer from `answer`. */
  function stubbed(answer: (host: string) => Response | Promise<Response>) {
    useTestNet(
      createTestNet({
        'a.test': { ip: '93.184.216.63', reply: { kind: 'hang' } },
        'b.test': { ip: '93.184.216.64', reply: { kind: 'hang' } },
      }),
    );
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => {
      seen.push(u);
      return answer(new URL(u).hostname);
    });
    return seen;
  }

  it('refuses a redirect to a Location that is no URL', async () => {
    stubbed(() => new Response(null, { status: 302, headers: { location: 'http://[::1' } }));
    expect(await vetVideoUrl('https://a.test/watch')).toMatch(
      /^refusing a redirect to an invalid URL \(302\)$/,
    );
  });

  it('refuses a link whose redirect target fails, in any way', async () => {
    const seen = stubbed((host) => {
      if (host === 'a.test') {
        return new Response(null, { status: 302, headers: { location: 'https://b.test/v' } });
      }
      throw new TypeError('fetch failed');
    });
    expect(await vetVideoUrl('https://a.test/watch')).toBe(
      "the link's redirect could not be followed (fetch failed), so its redirects could not all be checked",
    );
    expect(seen).toEqual(['https://a.test/watch', 'https://b.test/v']);
  });

  it('leaves a failure on the link itself to the sidecar, as before', async () => {
    stubbed(() => {
      throw new TypeError('fetch failed');
    });
    expect(await walkVideoUrl('https://a.test/watch')).toEqual({
      ok: true,
      url: 'https://a.test/watch',
    });
  });

  it('hands the sidecar the canonical form, so no parser reads another host', async () => {
    const seen = stubbed(() => new Response('x'));
    // A backslash is a slash to the URL parser (host a.test) and could be
    // userinfo to another (host 169.254.169.254).
    expect(await walkVideoUrl('http://a.test\\@169.254.169.254/latest/')).toEqual({
      ok: true,
      url: 'http://a.test/@169.254.169.254/latest/',
    });
    expect(seen).toEqual(['http://a.test/@169.254.169.254/latest/']);
  });
});
