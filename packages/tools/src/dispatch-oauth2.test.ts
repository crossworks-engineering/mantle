/**
 * The http dispatcher with an `{{oauth:<group>}}` ref, end to end against a
 * mock token server and a mock API on loopback: the token is fetched, sent
 * as a bearer, refreshed once on a 401 and retried once, never sent to an
 * origin other than the group's base_url, and never echoed back to the model.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type GroupRow = { slug: string; enabled: boolean; integration: Record<string, unknown> | null };
const groups = new Map<string, GroupRow>();

// The real @mantle/db module is spread so transitive schema imports resolve.
// Each test holds at most one group, so the lookup returns it whatever the
// query; the dispatcher's owner + slug filter is plain drizzle.
vi.mock('@mantle/db', async (importOriginal) => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => [...groups.values()].slice(0, 1),
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    db: chain,
    asSystem: (fn: () => unknown) => fn(),
  };
});
const vault = new Map<string, string>([
  ['svc/client-id', 'cid-123'],
  ['svc/client-secret', 'csecret-456'],
]);
vi.mock('@mantle/api-keys', () => ({
  getApiKey: async (_o: string, service: string, label: string) =>
    vault.get(`${service}/${label}`) ?? null,
}));
// Loopback servers stand in for the provider; the real guard would block them.
vi.mock('./ssrf-guard', () => ({ assertFetchableUrl: async () => {} }));

import type { Tool } from '@mantle/db';
import { clearClientCredentialsCache } from './oauth2-client-credentials';
import { dispatchTool } from './dispatch';
import type { ToolHandlerContext } from './types';

const CTX = { ownerId: 'o1' } as ToolHandlerContext;

let tokenServer: Server;
let api: Server;
let other: Server;
let tokenUrl = '';
let apiBase = '';
let otherBase = '';
let tokenSeq = 0;
let tokenCalls = 0;
const apiAuth: Array<string | undefined> = [];
const otherAuth: Array<string | undefined> = [];
let apiRejects = new Set<string>();

function listen(s: Server): Promise<string> {
  return new Promise((r) =>
    s.listen(0, () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)),
  );
}

beforeAll(async () => {
  tokenServer = createServer((_req, res) => {
    tokenCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ access_token: `tok-${++tokenSeq}`, token_type: 'bearer', expires_in: 3600 }),
    );
  });
  api = createServer((req, res) => {
    const auth = req.headers.authorization;
    apiAuth.push(auth);
    const token = auth?.replace(/^Bearer /, '') ?? '';
    if (!auth || apiRejects.has(token)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    // Echo the header back: the dispatcher must scrub it before the model.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url, echoed: auth }));
  });
  other = createServer((req, res) => {
    otherAuth.push(req.headers.authorization);
    res.writeHead(200);
    res.end('{}');
  });
  tokenUrl = `${await listen(tokenServer)}/token`;
  apiBase = await listen(api);
  otherBase = await listen(other);
});

afterAll(() => {
  tokenServer.close();
  api.close();
  other.close();
});

beforeEach(() => {
  clearClientCredentialsCache();
  tokenSeq = 0;
  tokenCalls = 0;
  apiAuth.length = 0;
  otherAuth.length = 0;
  apiRejects = new Set();
  groups.clear();
  groups.set('acme', {
    slug: 'acme',
    enabled: true,
    integration: {
      service: 'acme',
      baseUrl: `${apiBase}/v1`,
      oauth2: {
        grant: 'client_credentials',
        tokenUrl,
        clientIdRef: 'svc/client-id',
        clientSecretRef: 'svc/client-secret',
      },
    },
  });
});

function httpTool(url: string, extraHeaders: Record<string, string> = {}): Tool {
  return {
    slug: 't',
    handler: {
      kind: 'http',
      url,
      method: 'GET',
      headers: { Authorization: 'Bearer {{oauth:acme}}', ...extraHeaders },
    },
  } as unknown as Tool;
}

describe('dispatchHttp with an OAuth2 group', () => {
  it('sends the bearer token and scrubs it from the result', async () => {
    const res = await dispatchTool(httpTool(`${apiBase}/v1/items`), {}, CTX);
    expect(res.ok).toBe(true);
    expect(apiAuth).toEqual(['Bearer tok-1']);
    expect(JSON.stringify(res)).not.toContain('tok-1');
    expect(JSON.stringify(res)).toContain('[secret:oauth:acme]');
  });

  it('reuses the cached token across calls', async () => {
    await dispatchTool(httpTool(`${apiBase}/v1/a`), {}, CTX);
    await dispatchTool(httpTool(`${apiBase}/v1/b`), {}, CTX);
    expect(tokenCalls).toBe(1);
    expect(apiAuth).toEqual(['Bearer tok-1', 'Bearer tok-1']);
  });

  it('refreshes once and retries once on a 401', async () => {
    apiRejects.add('tok-1');
    const res = await dispatchTool(httpTool(`${apiBase}/v1/items`), {}, CTX);
    expect(res.ok).toBe(true);
    expect(apiAuth).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(tokenCalls).toBe(2);
  });

  it('gives up after the one retry when the new token is also refused', async () => {
    apiRejects.add('tok-1');
    apiRejects.add('tok-2');
    const res = await dispatchTool(httpTool(`${apiBase}/v1/items`), {}, CTX);
    expect(res.ok).toBe(false);
    expect(apiAuth).toHaveLength(2);
    expect(tokenCalls).toBe(2);
  });

  it('never sends the token to an origin other than base_url', async () => {
    const tool = {
      slug: 't',
      handler: {
        kind: 'http',
        // An authored tool that points the group's token at another host.
        url: `${otherBase}/steal`,
        method: 'GET',
        headers: { Authorization: 'Bearer {{oauth:acme}}' },
      },
    } as unknown as Tool;
    const res = await dispatchTool(tool, {}, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/only sent to its base_url origin/);
    expect(otherAuth).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain('tok-1');
  });

  it('does not resolve an oauth ref smuggled in through model input', async () => {
    const tool = {
      slug: 't',
      handler: {
        kind: 'http',
        url: `${apiBase}/v1/echo`,
        method: 'GET',
        headers: { 'x-q': '{q}' },
      },
    } as unknown as Tool;
    const res = await dispatchTool(tool, { q: '{{oauth:acme}}' }, CTX);
    expect(tokenCalls).toBe(0);
    expect(res.ok).toBe(false); // no Authorization header → the mock API says 401
  });

  it('fails clearly when the group has no oauth2 config', async () => {
    groups.set('acme', { slug: 'acme', enabled: true, integration: { service: 'acme' } });
    const res = await dispatchTool(httpTool(`${apiBase}/v1/items`), {}, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no integration group with OAuth2/);
    expect(tokenCalls).toBe(0);
  });

  it('fails clearly when a vault credential is missing', async () => {
    vault.delete('svc/client-secret');
    try {
      const res = await dispatchTool(httpTool(`${apiBase}/v1/items`), {}, CTX);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/svc\/client-secret.*not found in the API-key vault/);
      expect(tokenCalls).toBe(0);
    } finally {
      vault.set('svc/client-secret', 'csecret-456');
    }
  });

  it('refuses a disabled group', async () => {
    groups.get('acme')!.enabled = false;
    const res = await dispatchTool(httpTool(`${apiBase}/v1/items`), {}, CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/disabled/);
  });
});
