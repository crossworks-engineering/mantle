import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EgressRefusedError } from '@mantle/std/egress';
import {
  assertFetchableUrl,
  assertPublicUrl,
  gatewaySlug,
  guardedFetch,
  hopGuard,
  isBlockedIp,
  isGatewayUrl,
} from './ssrf-guard';
import { gatewayConnectorFetch, gatewayHttpBinding, withGatewayHeaders } from './gateway';
import { safeFetch } from './safe-fetch';

describe('isBlockedIp', () => {
  it('blocks loopback, private, link-local, CGNAT, and metadata', () => {
    for (const ip of [
      '127.0.0.1',
      '127.5.5.5',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT / tailscale
      '0.0.0.0',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('handles IPv6 loopback, ULA, link-local, and IPv4-mapped', () => {
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('fc00::1')).toBe(true);
    expect(isBlockedIp('fd12:3456::1')).toBe(true);
    expect(isBlockedIp('fe80::1')).toBe(true);
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });

  it('fails closed on unparseable input', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});

describe('assertFetchableUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertFetchableUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertFetchableUrl('gopher://x')).rejects.toThrow();
  });

  it('rejects literal private/metadata IPs', async () => {
    await expect(assertFetchableUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /private\/internal/,
    );
    await expect(assertFetchableUrl('http://127.0.0.1:5432')).rejects.toThrow();
    await expect(assertFetchableUrl('http://[::1]/')).rejects.toThrow();
  });

  it('rejects localhost (resolves to loopback)', async () => {
    await expect(assertFetchableUrl('http://localhost:3000/')).rejects.toThrow();
  });

  describe('the sandboxd proxy exemption (the ONE deliberate carve)', () => {
    const base = 'http://sandboxd:8090';
    const withEnv = async (value: string | undefined, fn: () => Promise<void>) => {
      const prev = process.env.SANDBOXD_URL;
      if (value === undefined) delete process.env.SANDBOXD_URL;
      else process.env.SANDBOXD_URL = value;
      try {
        await fn();
      } finally {
        if (prev === undefined) delete process.env.SANDBOXD_URL;
        else process.env.SANDBOXD_URL = prev;
      }
    };

    it('allows the data-plane proxy path on the exact sandboxd origin', async () => {
      await withEnv(base, async () => {
        await expect(
          assertFetchableUrl(`${base}/svc/11111111-2222-4333-8444-555555555555/8000/calc`),
        ).resolves.toBeUndefined();
      });
    });

    it("does NOT expose sandboxd's control plane (/sandboxes)", async () => {
      await withEnv(base, async () => {
        await expect(assertFetchableUrl(`${base}/sandboxes`)).rejects.toThrow();
        await expect(assertFetchableUrl(`${base}/healthz`)).rejects.toThrow();
      });
    });

    it('does NOT leak to other private hosts, even with /svc/ paths', async () => {
      await withEnv(base, async () => {
        await expect(assertFetchableUrl('http://postgres:5432/svc/x')).rejects.toThrow();
        await expect(assertFetchableUrl('http://127.0.0.1:8090/svc/x')).rejects.toThrow();
      });
    });

    it('is inert when SANDBOXD_URL is unset', async () => {
      await withEnv(undefined, async () => {
        await expect(assertFetchableUrl(`${base}/svc/x/8000/`)).rejects.toThrow();
      });
    });
  });

  it('allows a public literal IP', async () => {
    await expect(assertFetchableUrl('https://1.1.1.1/')).resolves.toBeUndefined();
  });
});

describe('the service gateway exemption (the second deliberate carve)', () => {
  const base = 'http://gateway:8097';
  const withGateway = async (value: string | undefined, fn: () => Promise<void>) => {
    vi.stubEnv('GATEWAY_URL', value);
    try {
      await fn();
    } finally {
      vi.unstubAllEnvs();
    }
  };

  it('allows /svc/<slug>/ on the exact gateway origin', async () => {
    await withGateway(base, async () => {
      await expect(assertFetchableUrl(`${base}/svc/billing/query`)).resolves.toBeUndefined();
      await expect(assertFetchableUrl(`${base}/svc/billing`)).resolves.toBeUndefined();
      await expect(assertFetchableUrl(`${base}/svc/billing/mcp?x=1`)).resolves.toBeUndefined();
    });
  });

  it('still refuses every other private host, even with /svc/ paths', async () => {
    await withGateway(base, async () => {
      await expect(assertFetchableUrl('http://postgres:5432/svc/billing/x')).rejects.toThrow();
      await expect(assertFetchableUrl('http://127.0.0.1:8097/svc/billing/x')).rejects.toThrow();
      await expect(assertFetchableUrl('http://10.0.0.5/svc/billing/x')).rejects.toThrow();
      await expect(assertFetchableUrl('http://gateway:8098/svc/billing/x')).rejects.toThrow();
      await expect(assertFetchableUrl('https://gateway:8097/svc/billing/x')).rejects.toThrow();
      // The service's own private address, called directly.
      await expect(assertFetchableUrl('http://172.30.0.7:8080/query')).rejects.toThrow();
    });
  });

  it('refuses the same host on any other path', async () => {
    await withGateway(base, async () => {
      for (const path of ['/', '/healthz', '/svc/', '/svc', '/svcx/billing', '/api/svc/billing']) {
        await expect(assertFetchableUrl(`${base}${path}`), path).rejects.toThrow();
      }
      // A slug the gateway would never route (upper case, too long, odd).
      await expect(assertFetchableUrl(`${base}/svc/BILLING/x`)).rejects.toThrow();
      await expect(assertFetchableUrl(`${base}/svc/-x/y`)).rejects.toThrow();
      await expect(assertFetchableUrl(`${base}/svc/${'a'.repeat(41)}/y`)).rejects.toThrow();
    });
  });

  it('reads the slug from the URL as fetch sends it (dot segments resolved)', async () => {
    await withGateway(base, async () => {
      expect(gatewaySlug(new URL(`${base}/svc/a/../b/x`))).toBe('b');
      expect(gatewaySlug(new URL(`${base}/svc/a/%2e%2e/b/x`))).toBe('b');
      expect(gatewaySlug(new URL(`${base}/svc/a/../../healthz`))).toBeNull();
      expect(isGatewayUrl(new URL(`${base}/svc/a`))).toBe(true);
    });
  });

  it('assertPublicUrl (a URL for a third party) takes no carve', async () => {
    await withGateway(base, async () => {
      await expect(assertPublicUrl(`${base}/svc/billing/x`)).rejects.toThrow();
    });
  });

  it('is inert when GATEWAY_URL is unset', async () => {
    await withGateway(undefined, async () => {
      await expect(assertFetchableUrl(`${base}/svc/billing/x`)).rejects.toThrow();
      expect(isGatewayUrl(new URL(`${base}/svc/billing/x`))).toBe(false);
    });
  });

  describe('redirects', () => {
    // A loopback server stands in for the gateway (GATEWAY_URL points at it,
    // so the carve is the one way the fetch reaches it).
    let srv: http.Server;
    let gw = '';
    const hits: string[] = [];
    beforeAll(async () => {
      srv = http.createServer((req, res) => {
        hits.push(req.url ?? '');
        const to: Record<string, string> = {
          '/svc/a/out-private': 'http://127.0.0.1:1/x',
          '/svc/a/out-public': 'http://example.invalid/x',
          '/svc/a/other-slug': '/svc/b/x',
          '/svc/a/off-svc': '/healthz',
          '/svc/a/same': '/svc/a/ok',
        };
        const loc = to[req.url ?? ''];
        if (loc) {
          res.writeHead(302, { location: loc });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      gw = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    });
    afterAll(() => {
      srv.closeAllConnections();
      srv.close();
    });

    const fetches: Array<[string, (u: string) => Promise<Response>]> = [
      ['guardedFetch', (u) => guardedFetch(u)],
      ['safeFetch (http tools)', (u) => safeFetch(u, { method: 'GET' }, [])],
    ];

    describe.each(fetches)('%s', (_name, f) => {
      it('follows a redirect that stays on the same service', async () => {
        await withGateway(gw, async () => {
          const res = await f(`${gw}/svc/a/same`);
          expect(await res.text()).toBe('ok');
        });
      });

      it('refuses a redirect out of the gateway (private or public)', async () => {
        await withGateway(gw, async () => {
          await expect(f(`${gw}/svc/a/out-private`)).rejects.toThrow(EgressRefusedError);
          await expect(f(`${gw}/svc/a/out-public`)).rejects.toThrow(/out of gateway service 'a'/);
        });
      });

      it('refuses a redirect to another service or off /svc/ on the gateway', async () => {
        await withGateway(gw, async () => {
          hits.length = 0;
          await expect(f(`${gw}/svc/a/other-slug`)).rejects.toThrow(EgressRefusedError);
          await expect(f(`${gw}/svc/a/off-svc`)).rejects.toThrow(EgressRefusedError);
          expect(hits).toEqual(['/svc/a/other-slug', '/svc/a/off-svc']);
        });
      });
    });

    it('refuses a redirect INTO the gateway from anywhere else', async () => {
      await withGateway(base, async () => {
        const guard = hopGuard('https://1.1.1.1/start');
        await expect(guard('https://1.1.1.1/start')).resolves.toBeUndefined();
        await expect(guard(`${base}/svc/billing/x`)).rejects.toThrow(/into the service gateway/);
      });
    });
  });

  describe("a call carries the token only to its tool's own service", () => {
    it('an http tool: the slug must be literal in the URL its author wrote', async () => {
      await withGateway(base, async () => {
        expect(gatewayHttpBinding('https://api.example.com/{x}', 'https://api.example.com/y')).toBe(
          null,
        );
        expect(
          gatewayHttpBinding(`${base}/svc/billing/query`, `${base}/svc/billing/query`),
        ).toEqual({
          slug: 'billing',
        });
        expect(
          gatewayHttpBinding(`${base}/svc/billing/{path}`, `${base}/svc/billing/rows`),
        ).toEqual({
          slug: 'billing',
        });
        // Two model-filled segments step to another service: refused.
        expect(
          gatewayHttpBinding(`${base}/svc/billing/{a}/{b}`, `${base}/svc/billing/../payroll`),
        ).toEqual({
          error: expect.stringMatching(/written for gateway service 'billing'/),
        });
        // A slug filled from a parameter: refused.
        expect(gatewayHttpBinding(`${base}/svc/{slug}/q`, `${base}/svc/billing/q`)).toEqual({
          error: expect.stringMatching(/must be fixed/),
        });
        expect(gatewayHttpBinding(`${base}/svc/bi{x}/q`, `${base}/svc/billing/q`)).toEqual({
          error: expect.stringMatching(/must be fixed/),
        });
        // A secret in a gateway URL would land in the gateway's log.
        expect(
          gatewayHttpBinding(
            `${base}/svc/billing/q?k={{secret:billing/key}}`,
            `${base}/svc/billing/q?k=x`,
          ),
        ).toEqual({ error: expect.stringMatching(/may not carry/) });
        // A tool written for a public API that a parameter points at the
        // gateway gets no token either.
        expect(gatewayHttpBinding('{base}/q', `${base}/svc/billing/q`)).toEqual({
          error: expect.stringMatching(/must be fixed/),
        });
      });
    });

    it("a tool's own gateway headers, in any letter case, never reach the log", () => {
      vi.stubEnv('GATEWAY_TOKEN', 'tok');
      try {
        const out = withGatewayHeaders(
          {
            Authorization: 'Bearer k',
            'X-Mantle-Caller': 'agent:forged',
            'X-MANTLE-LOGIN': '11111111-2222-4333-8444-555555555555',
            'x-mantle-gateway-token': 'guess',
          },
          { caller: 'agent:real', loginId: null },
        );
        expect(out).toEqual({
          Authorization: 'Bearer k',
          'x-mantle-gateway-token': 'tok',
          'x-mantle-caller': 'agent:real',
          'x-mantle-login': '',
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('an MCP connector: requests stay on the slug of its own URL', async () => {
      await withGateway(base, async () => {
        vi.stubEnv('GATEWAY_TOKEN', 'tok');
        const seen: Array<[string, Headers]> = [];
        const inner: typeof fetch = async (input, init) => {
          seen.push([String(input), new Headers(init?.headers)]);
          return new Response('ok');
        };
        const f = gatewayConnectorFetch(`${base}/svc/billing/mcp`, 'mcp-billing', inner);
        await f(`${base}/svc/billing/mcp`, {
          method: 'POST',
          headers: { authorization: 'Bearer k' },
        });
        expect(seen[0]![1].get('x-mantle-gateway-token')).toBe('tok');
        expect(seen[0]![1].get('x-mantle-caller')).toBe('connector:mcp-billing');
        expect(seen[0]![1].get('authorization')).toBe('Bearer k');
        await expect(f(`${base}/svc/payroll/mcp`, { method: 'POST' })).rejects.toThrow(
          /bound to 'billing'/,
        );
        // A connector to a public server never sends the gateway headers.
        const pub = gatewayConnectorFetch('https://mcp.example.com/mcp', 'ext', inner);
        await expect(pub(`${base}/svc/billing/mcp`, { method: 'POST' })).rejects.toThrow(
          /bound to no gateway service/,
        );
        await pub('https://mcp.example.com/mcp', { method: 'POST' });
        expect(seen.at(-1)![1].get('x-mantle-gateway-token')).toBeNull();
      });
    });
  });
});
