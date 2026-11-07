/**
 * The gateway's server against a loopback service: the registry, the
 * address check and the call log are stubs, the HTTP is real.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayCallEntry } from '@mantle/db';
import { createGateway } from './server';
import { RegistryUnavailable } from './brain';
import type { RouteService } from './route';

const TOKEN = 'gw-test-token';
let upstream: http.Server;
let gateway: http.Server;
let gw = '';
let upPort = 0;
const seen: Array<{
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}> = [];
const calls: GatewayCallEntry[] = [];

const services: Record<string, RouteService> = {
  billing: {
    slug: 'billing',
    upstream: 'billing-agent:0',
    pathPrefixes: ['/mcp', '/api/'],
    methods: ['GET', 'POST'],
    enabled: true,
  },
  off: {
    slug: 'off',
    upstream: 'billing-agent:0',
    pathPrefixes: ['/'],
    methods: ['GET'],
    enabled: false,
  },
  stack: {
    slug: 'stack',
    upstream: 'postgres:5432',
    pathPrefixes: ['/'],
    methods: ['GET'],
    enabled: true,
  },
  elsewhere: {
    slug: 'elsewhere',
    upstream: 'not-on-services:80',
    pathPrefixes: ['/'],
    methods: ['GET'],
    enabled: true,
  },
};

function start(
  token: string,
  fromService?: (remote: string | undefined) => boolean,
): Promise<http.Server> {
  const s = createGateway({
    fromService,
    token,
    lookup: async (slug) => {
      const row = services[slug];
      return row ? { ...row, upstream: row.upstream.replace(/:0$/, `:${upPort}`) } : null;
    },
    address: async (host) => (host === 'billing-agent' ? '127.0.0.1' : null),
    record: (e) => calls.push(e),
    maxBodyBytes: 1024,
    idleTimeoutMs: 5_000,
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.url === '/api/redirect') {
        res.writeHead(302, { location: 'http://example.invalid/x' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upPort = (upstream.address() as AddressInfo).port;
  gateway = await start(TOKEN);
  gw = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});

afterAll(() => {
  for (const s of [gateway, upstream]) {
    s.closeAllConnections();
    s.close();
  }
});

beforeEach(() => {
  seen.length = 0;
  calls.length = 0;
});

const auth = { 'x-mantle-gateway-token': TOKEN };
/** The call row of the last request (written when its response closes). */
async function lastCall(): Promise<GatewayCallEntry> {
  for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  return calls.at(-1)!;
}

describe('the gateway server', () => {
  it('answers /healthz with no token', async () => {
    const res = await fetch(`${gw}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('sends an allowed call on, without its own headers, and logs it', async () => {
    const res = await fetch(`${gw}/svc/billing/mcp?q=1`, {
      method: 'POST',
      headers: {
        ...auth,
        authorization: 'Bearer service-key',
        'x-mantle-caller': 'agent:billing-analyst',
        'x-mantle-login': '11111111-2222-4333-8444-555555555555',
        'x-http-method-override': 'DELETE',
        'x-http-method': 'DELETE',
        'x-method-override': 'DELETE',
        'content-type': 'application/json',
      },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, url: '/mcp?q=1' });
    const got = seen[0]!;
    expect(got.method).toBe('POST');
    expect(got.body).toBe('{"jsonrpc":"2.0"}');
    expect(got.headers.authorization).toBe('Bearer service-key');
    expect(got.headers['x-mantle-gateway-token']).toBeUndefined();
    expect(got.headers['x-mantle-caller']).toBeUndefined();
    expect(got.headers['x-mantle-login']).toBeUndefined();
    // A method override would step past the allowed methods.
    expect(got.headers['x-http-method-override']).toBeUndefined();
    expect(got.headers['x-http-method']).toBeUndefined();
    expect(got.headers['x-method-override']).toBeUndefined();
    expect(got.headers.host).toBe(`billing-agent:${upPort}`);
    expect(got.headers['x-forwarded-prefix']).toBe('/svc/billing');
    expect(await lastCall()).toMatchObject({
      serviceSlug: 'billing',
      method: 'POST',
      path: '/mcp',
      status: 200,
      requestBytes: 17,
      caller: 'agent:billing-analyst',
      loginId: '11111111-2222-4333-8444-555555555555',
      refusal: null,
    });
    expect((await lastCall()).responseBytes).toBeGreaterThan(0);
  });

  it('caps the path on the call row at 512 characters', async () => {
    const res = await fetch(`${gw}/svc/billing/api/${'a'.repeat(2_000)}`, { headers: auth });
    expect(res.status).toBe(200);
    await res.text();
    expect((await lastCall()).path).toBe(`/api/${'a'.repeat(507)}`);
  });

  it('passes a redirect back as it is (the brain refuses one that leaves)', async () => {
    const res = await fetch(`${gw}/svc/billing/api/redirect`, {
      headers: auth,
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://example.invalid/x');
  });

  const refusals: Array<[string, string, RequestInit, number, string]> = [
    ['an unregistered slug', '/svc/nope/mcp', { headers: auth }, 404, 'unknown_service'],
    ['a switched-off service', '/svc/off/x', { headers: auth }, 403, 'service_disabled'],
    [
      'a method it does not allow',
      '/svc/billing/mcp',
      { method: 'DELETE', headers: auth },
      405,
      'method_not_allowed',
    ],
    ['a path it does not allow', '/svc/billing/admin', { headers: auth }, 403, 'path_not_allowed'],
    ['a prefix look-alike', '/svc/billing/mcpx', { headers: auth }, 403, 'path_not_allowed'],
    ['an encoded separator', '/svc/billing/mcp%2F..%2Fadmin', { headers: auth }, 400, 'bad_path'],
    ['a path parameter step', '/svc/billing/api/..;/admin', { headers: auth }, 400, 'bad_path'],
    [
      'a double-encoded dot',
      '/svc/billing/api/%252e%252e/admin',
      { headers: auth },
      400,
      'bad_path',
    ],
    ['anything off /svc/', '/admin', { headers: auth }, 404, 'not_found'],
    ['a stack service upstream', '/svc/stack/x', { headers: auth }, 403, 'service_disabled'],
    [
      'an upstream off the services network',
      '/svc/elsewhere/x',
      { headers: auth },
      502,
      'upstream_refused',
    ],
  ];

  it.each(refusals)('refuses %s, logged with its code', async (_n, path, init, status, code) => {
    const res = await fetch(`${gw}${path}`, init);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
    expect(seen).toEqual([]);
    expect(await lastCall()).toMatchObject({ status, refusal: code });
  });

  it('refuses a call without the token, and leaves no row for it', async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const headers of <Array<Record<string, string>>>[
        {},
        { 'x-mantle-gateway-token': 'nope' },
        { authorization: `Bearer ${TOKEN}` },
        { 'x-mantle-caller': 'agent:forged' },
      ]) {
        const res = await fetch(`${gw}/svc/billing/mcp`, { headers });
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ code: 'unauthorized' });
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toEqual([]);
      expect(seen).toEqual([]);
    } finally {
      console.warn = warn;
    }
  });

  it('refuses a body over the cap, declared or streamed', async () => {
    const res = await fetch(`${gw}/svc/billing/mcp`, {
      method: 'POST',
      headers: auth,
      body: 'x'.repeat(4096),
    });
    expect(res.status).toBe(413);
    // No content-length: the cap holds while the body streams.
    const big = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 8; i++) c.enqueue(new Uint8Array(512).fill(120));
        c.close();
      },
    });
    const streamed = await fetch(`${gw}/svc/billing/mcp`, {
      method: 'POST',
      headers: auth,
      body: big,
      duplex: 'half',
    } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(await lastCall()).toMatchObject({ refusal: 'too_large' });
  });

  it('answers 502 gateway_error, and logs it, when the registry cannot be read', async () => {
    const broken = createGateway({
      token: TOKEN,
      lookup: async () => {
        throw new Error('registry down');
      },
      address: async () => '127.0.0.1',
      record: (e) => calls.push(e),
      maxBodyBytes: 1024,
      idleTimeoutMs: 5_000,
    });
    await new Promise<void>((r) => broken.listen(0, '127.0.0.1', r));
    const err = console.error;
    console.error = () => {};
    try {
      const url = `http://127.0.0.1:${(broken.address() as AddressInfo).port}`;
      const res = await fetch(`${url}/svc/billing/mcp`, { headers: auth });
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: 'gateway_error' });
      expect(await lastCall()).toMatchObject({ status: 502, refusal: 'gateway_error' });
    } finally {
      console.error = err;
      broken.closeAllConnections();
      broken.close();
    }
  });

  it('refuses every call, 503 registry_unavailable, while the brain does not answer', async () => {
    const closed = createGateway({
      token: TOKEN,
      lookup: async () => {
        throw new RegistryUnavailable('the brain did not answer');
      },
      address: async () => '127.0.0.1',
      record: (e) => calls.push(e),
      maxBodyBytes: 1024,
      idleTimeoutMs: 5_000,
    });
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
      const res = await fetch(`${url}/svc/billing/mcp`, { headers: auth });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'registry_unavailable' });
      expect(seen).toEqual([]);
      expect(await lastCall()).toMatchObject({ status: 503, refusal: 'registry_unavailable' });
    } finally {
      closed.closeAllConnections();
      closed.close();
    }
  });

  it('serves no service without a token on the box', async () => {
    const bare = await start('');
    try {
      const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
      const warn = console.warn;
      console.warn = () => {};
      const res = await fetch(`${url}/svc/billing/mcp`, { headers: auth }).finally(() => {
        console.warn = warn;
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'no_token' });
      expect(seen).toEqual([]);
    } finally {
      bare.closeAllConnections();
      bare.close();
    }
  });

  it('drops a connection from a service, the token too', async () => {
    const closed = await start(TOKEN, (remote) => remote === '127.0.0.1');
    try {
      const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
      await expect(
        fetch(`${url}/svc/billing/mcp`, { method: 'POST', headers: auth }),
      ).rejects.toThrow();
      await expect(fetch(`${url}/healthz`)).rejects.toThrow();
      expect(seen).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      closed.closeAllConnections();
      closed.close();
    }
  });
});
