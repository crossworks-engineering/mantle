/**
 * egressFetch (A10 part 1, docs/egress.md): the address check on every hop,
 * secret headers across origins, the deadline and the streamed byte cap.
 * DNS and the platform fetch are the fake network of egress-test-net.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', async () => (await import('./egress-test-net')).testNetDnsModule);

import {
  assertEgressUrl,
  egressFetch,
  EgressRefusedError,
  EgressTooLargeError,
  isBlockedIp,
} from './egress';
import {
  createTestNet,
  egressTestHosts,
  HUGE_BYTES,
  useTestNet,
  type TestNet,
} from './egress-test-net';

function install(): TestNet {
  const net = createTestNet(egressTestHosts('ok body', 'text/plain'));
  useTestNet(net);
  vi.stubGlobal('fetch', net.fetch);
  return net;
}

afterEach(() => {
  useTestNet(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('isBlockedIp', () => {
  it('blocks private, loopback, CGNAT, link-local and metadata by default', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '::1',
      'fd12::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '::7f00:1',
      '64:ff9b::a9fe:a9fe',
      '2002:a9fe:a9fe::1',
      'fec0::1',
      'ff02::1',
      '::ffff:0:7f00:1',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('lets a LAN caller reach private and tailnet space, never link-local or metadata', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '100.101.102.103',
      '::1',
      'fd12::1',
    ]) {
      expect(isBlockedIp(ip, { allowLan: true }), ip).toBe(false);
    }
    for (const ip of ['169.254.169.254', '169.254.1.1', 'fe80::1', '0.0.0.0', '224.0.0.1', '::']) {
      expect(isBlockedIp(ip, { allowLan: true }), ip).toBe(true);
    }
  });

  it('refuses the cloud metadata addresses inside the private ranges, even for a LAN caller', async () => {
    for (const ip of [
      '100.100.100.200',
      '192.0.0.192',
      'fd00:ec2::254',
      '::ffff:100.100.100.200',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
      expect(isBlockedIp(ip, { allowLan: true }), ip).toBe(true);
    }
    // Their neighbours stay LAN space.
    for (const ip of ['100.100.100.199', '192.0.0.191', 'fd00:ec2::253']) {
      expect(isBlockedIp(ip, { allowLan: true }), ip).toBe(false);
    }
    for (const u of [
      'http://100.100.100.200/latest/meta-data/',
      'http://192.0.0.192/opc/v2/instance/',
      'http://[fd00:ec2::254]/latest/meta-data/',
    ]) {
      await expect(assertEgressUrl(u, { allowLan: true }), u).rejects.toBeInstanceOf(
        EgressRefusedError,
      );
    }
  });

  it('fails closed on input that is no IP', () => {
    expect(isBlockedIp('nope')).toBe(true);
    expect(isBlockedIp('nope', { allowLan: true })).toBe(true);
  });
});

/** IPv6 literals that carry, tunnel to or stand for an address the v4
 *  rules refuse, written as a URL host. The URL parser rewrites the dotted
 *  form (`[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`), which is what the
 *  check sees. */
const V6_REFUSED_ALWAYS = [
  'http://[::ffff:169.254.169.254]/latest/meta-data/', // IPv4-mapped metadata
  'http://[::ffff:a9fe:a9fe]/', // the same, hex
  'http://[::169.254.169.254]/', // IPv4-compatible
  'http://[::ffff:0:a9fe:a9fe]/', // IPv4-translated
  'http://[64:ff9b::169.254.169.254]/', // NAT64
  'http://[64:ff9b:1::a9fe:a9fe]/', // local-use NAT64
  'http://[2002:a9fe:a9fe::1]/', // 6to4
  'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', // Teredo
  'http://[fec0::1]/', // site-local
  'http://[ff02::1]/', // multicast
  'http://[::ffff:0.0.0.0]/', // mapped "this network"
];
/** Refused by default, let through for a LAN caller (their v4 is LAN). */
const V6_REFUSED_UNLESS_LAN = [
  'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:7f00:1]/',
  'http://[::127.0.0.1]/',
  'http://[::ffff:0:7f00:1]/',
  'http://[64:ff9b::10.0.0.5]/',
  'http://[2002:c0a8:101::1]/', // 6to4 of 192.168.1.1
  'http://[::ffff:100.64.0.1]/',
];

describe('IPv6 forms of a refused IPv4 address', () => {
  it('refuses every form through assertEgressUrl, with and without allowLan', async () => {
    for (const u of V6_REFUSED_ALWAYS) {
      await expect(assertEgressUrl(u), u).rejects.toBeInstanceOf(EgressRefusedError);
      await expect(assertEgressUrl(u, { allowLan: true }), u).rejects.toBeInstanceOf(
        EgressRefusedError,
      );
    }
    for (const u of V6_REFUSED_UNLESS_LAN) {
      await expect(assertEgressUrl(u), u).rejects.toBeInstanceOf(EgressRefusedError);
      await expect(assertEgressUrl(u, { allowLan: true }), u).resolves.toBeUndefined();
    }
  });

  it('lets the public forms through', async () => {
    for (const u of [
      'http://[::ffff:8.8.8.8]/',
      'http://[64:ff9b::808:808]/',
      'http://[2002:808:808::1]/',
      'http://[2606:4700:4700::1111]/',
    ]) {
      await expect(assertEgressUrl(u), u).resolves.toBeUndefined();
    }
  });

  it('refuses them through egressFetch before any request', async () => {
    const net = install();
    for (const u of [...V6_REFUSED_ALWAYS, ...V6_REFUSED_UNLESS_LAN]) {
      await expect(egressFetch(u), u).rejects.toBeInstanceOf(EgressRefusedError);
    }
    for (const u of V6_REFUSED_ALWAYS) {
      await expect(egressFetch(u, {}, { allowLan: true }), u).rejects.toBeInstanceOf(
        EgressRefusedError,
      );
    }
    expect(net.log).toEqual([]);
  });

  it('refuses a redirect to a mapped metadata address', async () => {
    const net = createTestNet({
      'mapped-redirect.test': {
        ip: '93.184.216.41',
        reply: { kind: 'redirect', to: 'http://[::ffff:169.254.169.254]/latest/meta-data/' },
      },
    });
    useTestNet(net);
    vi.stubGlobal('fetch', net.fetch);
    await expect(
      egressFetch('https://mapped-redirect.test/', {}, { allowLan: true }),
    ).rejects.toBeInstanceOf(EgressRefusedError);
    expect(net.log.map((l) => l.host)).toEqual(['mapped-redirect.test']);
  });

  it('a real loopback server is not reachable through the mapped form', async () => {
    const srv = http.createServer((_q, s) => s.end('INTERNAL-ONLY'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    try {
      await expect(
        egressFetch(`http://[::ffff:127.0.0.1]:${port}/`, {}, { timeoutMs: 3000 }),
      ).rejects.toBeInstanceOf(EgressRefusedError);
    } finally {
      srv.close();
    }
  });
});

describe('assertEgressUrl', () => {
  it('refuses non-http schemes and names resolving into private space', async () => {
    install();
    await expect(assertEgressUrl('file:///etc/passwd')).rejects.toBeInstanceOf(EgressRefusedError);
    await expect(assertEgressUrl('http://inside.test/')).rejects.toThrow(/private\/internal/);
    await expect(assertEgressUrl('https://public.test/')).resolves.toBeUndefined();
  });

  it('refuses an unresolvable name, unless the caller is on the LAN', async () => {
    install();
    await expect(assertEgressUrl('https://nowhere.test/')).rejects.toThrow(/cannot resolve/);
    await expect(
      assertEgressUrl('https://nowhere.test/', { allowLan: true }),
    ).resolves.toBeUndefined();
  });

  it('skips the check for a URL the caller exempts', async () => {
    install();
    const exempt = (u: URL) => u.hostname === 'inside.test';
    await expect(assertEgressUrl('http://inside.test/', { exempt })).resolves.toBeUndefined();
  });
});

describe('egressFetch', () => {
  it('checks every redirect hop', async () => {
    const net = install();
    await expect(egressFetch('https://meta-redirect.test/x')).rejects.toThrow(
      /private\/internal address \(169\.254\.169\.254\)/,
    );
    expect(net.log.map((l) => l.host)).toEqual(['meta-redirect.test']);
  });

  it('a LAN caller still may not be redirected to the metadata address', async () => {
    install();
    await expect(egressFetch('http://10.0.0.5/', {}, { allowLan: true })).resolves.toHaveProperty(
      'status',
      200,
    );
    await expect(
      egressFetch('https://meta-redirect.test/x', {}, { allowLan: true }),
    ).rejects.toBeInstanceOf(EgressRefusedError);
  });

  it('drops Authorization, cookies and secret-carrying headers on a hop to another origin', async () => {
    const net = install();
    const res = await egressFetch(
      'https://cross-redirect.test/x',
      {
        headers: {
          authorization: 'Bearer S1',
          cookie: 'c=1',
          'x-api-key': 'key-S2',
          'x-plain': 'kept',
        },
      },
      { secrets: ['S2'] },
    );
    expect(res.status).toBe(200);
    const atOther = net.log.find((l) => l.host === 'other.test')!.headers;
    expect(atOther).toEqual({ 'x-plain': 'kept' });
  });

  it('downgrades a POST to GET on a 302, as the platform does', async () => {
    const net = install();
    await egressFetch('https://cross-redirect.test/x', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(net.log.map((l) => l.method)).toEqual(['POST', 'GET']);
    expect(net.log[1]!.headers['content-type']).toBeUndefined();
  });

  it('refuses any redirect in error mode', async () => {
    install();
    await expect(
      egressFetch('https://cross-redirect.test/x', {}, { redirect: 'error' }),
    ).rejects.toThrow(/fetch failed/);
  });

  it('stops reading at the byte cap', async () => {
    const net = install();
    const res = await egressFetch('https://huge.test/', {}, { maxBytes: 1024 * 1024 });
    await expect(res.text()).rejects.toBeInstanceOf(EgressTooLargeError);
    expect(net.hugeBytesPulled()).toBeLessThan(2 * 1024 * 1024);
    expect(net.hugeBytesPulled()).toBeLessThan(HUGE_BYTES);
  });

  it('ends the body at the cap in truncate mode', async () => {
    const net = install();
    const res = await egressFetch(
      'https://huge.test/',
      {},
      { maxBytes: 100_000, overflow: 'truncate' },
    );
    expect((await res.arrayBuffer()).byteLength).toBe(100_000);
    expect(net.hugeBytesPulled()).toBeLessThan(1024 * 1024);
  });

  it('times out a slow server', async () => {
    install();
    vi.useFakeTimers();
    const p = egressFetch('https://slow.test/', {}, { timeoutMs: 5_000 });
    const settled = expect(p).rejects.toThrow(/This operation was aborted/);
    await vi.advanceTimersByTimeAsync(5_001);
    await settled;
  });

  it('refuses after too many redirects', async () => {
    const net = createTestNet({
      'loop.test': { ip: '93.184.216.40', reply: { kind: 'redirect', to: 'https://loop.test/' } },
    });
    useTestNet(net);
    vi.stubGlobal('fetch', net.fetch);
    await expect(egressFetch('https://loop.test/', {}, { maxRedirects: 2 })).rejects.toThrow(
      /too many redirects \(>2\)/,
    );
    expect(net.log).toHaveLength(3);
  });
});
