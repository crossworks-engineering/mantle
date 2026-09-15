/**
 * Pre-registered OAuth apps against an Entra-shaped authorization server,
 * in-process (no external network). Shaped like Microsoft Entra ID as the
 * Power BI MCP server exposes it: RFC 9728 metadata pointing at a generic
 * `organizations` authority, no dynamic registration, OIDC-only discovery at
 * `<authority>/.well-known/openid-configuration`, no
 * `code_challenge_methods_supported`, and a token endpoint that wants the
 * secret in the body and refuses an RFC 8707 `resource` parameter.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ssrf-guard', () => ({ assertFetchableUrl: async () => {} }));

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolGroupMcpBinding } from '@mantle/db';
import { closeMcpClient, mcpListRemoteTools, setMcpOAuthStoreFactoryForTests } from './mcp-client';
import {
  abandonMcpOAuth,
  completeMcpOAuth,
  setMcpOAuthClient,
  startMcpOAuth,
  type McpOAuthStore,
  type MicrosoftOAuthApp,
} from './mcp-oauth';

const OWNER = 'owner-1';
const GROUP = 'mcp-entra';
const AUTH_CODE = 'entra-code';
const REDIRECT = 'http://127.0.0.1:9/cb';

const as = {
  /** Hits on the generic authority the server advertises. */
  genericHits: 0,
  registerHits: 0,
  tokenRequests: [] as Array<{ params: URLSearchParams; basic: boolean }>,
  validAccess: new Set<string>(),
  grants: 0,
  /** When set, the token endpoint answers with this Entra error. */
  tokenError: null as null | { error: string; error_description: string },
};

function issue() {
  const n = ++as.grants;
  as.validAccess = new Set([`access-${n}`]);
  return {
    access_token: `access-${n}`,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: `refresh-${n}`,
  };
}

function buildRemoteServer(): Server {
  const server = new Server(
    { name: 'entra-remote', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'ExecuteQuery', description: 'Run DAX.', inputSchema: { type: 'object' } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));
  return server;
}

let httpServer: http.Server;
let origin: string;
let binding: ToolGroupMcpBinding;
let msApp: MicrosoftOAuthApp | null;

function memoryStore(): McpOAuthStore & { secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
  return {
    groupSlug: GROUP,
    secrets,
    loadMcp: async () => binding,
    saveMcp: async (next) => {
      binding = next;
    },
    getSecret: async (l) => secrets.get(l) ?? null,
    setSecret: async (l, v) => {
      secrets.set(l, v);
    },
    deleteSecret: async (l) => {
      secrets.delete(l);
    },
    microsoftApp: async () => msApp,
  };
}
let store: ReturnType<typeof memoryStore>;

beforeAll(async () => {
  httpServer = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const readBody = async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        return Buffer.concat(chunks).toString('utf8');
      };
      const tenantMeta = (t: string) => ({
        issuer: `${origin}/${t}/v2.0`,
        authorization_endpoint: `${origin}/${t}/oauth2/v2.0/authorize`,
        token_endpoint: `${origin}/${t}/oauth2/v2.0/token`,
        // OIDC discovery fields Entra always sends (the SDK's schema requires them).
        jwks_uri: `${origin}/${t}/discovery/v2.0/keys`,
        subject_types_supported: ['pairwise'],
        id_token_signing_alg_values_supported: ['RS256'],
        response_types_supported: ['code', 'id_token', 'code id_token'],
        token_endpoint_auth_methods_supported: [
          'client_secret_post',
          'private_key_jwt',
          'client_secret_basic',
        ],
      });

      // RFC 9728, shaped like Power BI's: resource = origin, generic authority.
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        return json({
          resource: origin,
          authorization_servers: [`${origin}/organizations/v2.0`],
          scopes_supported: [`${origin}/.default`],
        });
      }
      if (url.pathname === '/organizations/v2.0/.well-known/openid-configuration') {
        as.genericHits++;
        return json(tenantMeta('organizations'));
      }
      if (url.pathname === '/tenant-1/v2.0/.well-known/openid-configuration') {
        return json(tenantMeta('tenant-1'));
      }
      if (url.pathname === '/register') {
        as.registerHits++;
        return json({ error: 'not supported' }, 404);
      }
      if (url.pathname === '/tenant-1/oauth2/v2.0/token') {
        const params = new URLSearchParams(await readBody());
        as.tokenRequests.push({ params, basic: /^Basic /.test(req.headers.authorization ?? '') });
        if (as.tokenError) return json(as.tokenError, 401);
        if (params.has('resource')) {
          return json(
            { error: 'invalid_request', error_description: 'AADSTS901002: resource' },
            400,
          );
        }
        const secretOk =
          (params.get('client_id') === 'ms-app' && params.get('client_secret') === 'ms-secret') ||
          params.get('client_id') === 'man-1';
        if (!secretOk)
          return json({ error: 'invalid_client', error_description: 'AADSTS7000215' }, 401);
        const grant = params.get('grant_type');
        if (grant === 'authorization_code') {
          if (params.get('code') !== AUTH_CODE || !params.get('code_verifier')) {
            return json({ error: 'invalid_grant', error_description: 'bad code' }, 400);
          }
          return json(issue());
        }
        if (grant === 'refresh_token') {
          if (params.get('refresh_token') !== `refresh-${as.grants}`) {
            return json({ error: 'invalid_grant', error_description: 'bad refresh' }, 400);
          }
          return json(issue());
        }
        return json({ error: 'unsupported_grant_type' }, 400);
      }
      if (url.pathname.startsWith('/.well-known/') || url.pathname !== '/mcp') {
        res.writeHead(404);
        return res.end();
      }

      // The protected MCP endpoint.
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!as.validAccess.has(bearer)) {
        res.writeHead(401, {
          'www-authenticate': `Bearer error="invalid_request", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        });
        return res.end();
      }
      const raw = await readBody();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await buildRemoteServer().connect(transport);
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  store = memoryStore();
  setMcpOAuthStoreFactoryForTests(() => store);
});

afterAll(async () => {
  await closeMcpClient(OWNER, GROUP);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  msApp = {
    clientId: 'ms-app',
    clientSecret: 'ms-secret',
    authorizationServer: `${origin}/tenant-1/v2.0`,
  };
  as.tokenError = null;
});

const fresh = (oauth: Partial<NonNullable<ToolGroupMcpBinding['oauth']>> = {}) => {
  binding = { url: `${origin}/mcp`, oauth: { enabled: true, status: 'pending', ...oauth } };
  store.secrets.clear();
};

describe('a server without dynamic registration', () => {
  it('fails start with a teaching error, and leaves no silent pending behind', async () => {
    fresh();
    await expect(startMcpOAuth(store, { redirectUri: REDIRECT })).rejects.toThrow(
      /does not let apps register themselves/,
    );
    expect(binding.oauth?.pending).toBeUndefined();
    expect(binding.oauth?.lastError).toMatch(/does not let apps register themselves/);
    expect(binding.oauth?.status).toBe('pending');
    expect(store.secrets.has('oauth-client')).toBe(false);
  });
});

describe('the Microsoft app', () => {
  it('start: tenant authority, no registration, offline_access, account picker, no resource', async () => {
    fresh({ client: { source: 'microsoft' } });
    const genericBefore = as.genericHits;
    const flow = await startMcpOAuth(store, { redirectUri: REDIRECT });
    if (!('authorizeUrl' in flow)) throw new Error('expected a redirect flow');
    const u = new URL(flow.authorizeUrl);
    expect(u.pathname).toBe('/tenant-1/oauth2/v2.0/authorize');
    expect(u.searchParams.get('client_id')).toBe('ms-app');
    expect(u.searchParams.get('scope')).toBe(`${origin}/.default offline_access`);
    expect(u.searchParams.getAll('prompt')).toEqual(['select_account']);
    expect(u.searchParams.has('resource')).toBe(false);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(as.genericHits).toBe(genericBefore);
    expect(as.registerHits).toBe(0);
    expect(store.secrets.has('oauth-client')).toBe(false); // borrowed, never copied
    expect(binding.oauth?.pending?.state).toBe(flow.state);
  });

  it('complete: secret in the body, no resource, tokens sealed', async () => {
    await completeMcpOAuth(store, { code: AUTH_CODE });
    const req = as.tokenRequests.at(-1)!;
    expect(req.params.get('grant_type')).toBe('authorization_code');
    expect(req.params.get('client_secret')).toBe('ms-secret');
    expect(req.basic).toBe(false);
    expect(req.params.has('resource')).toBe(false);
    expect(binding.oauth?.status).toBe('connected');
    expect(binding.oauth?.pending).toBeUndefined();
    expect(binding.oauth?.client).toEqual({ source: 'microsoft' });
    expect(store.secrets.has('oauth-verifier')).toBe(false);
  });

  it('runtime: calls with the token, and refreshes against the tenant authority', async () => {
    const { tools } = await mcpListRemoteTools(OWNER, GROUP, binding);
    expect(tools.map((t) => t.name)).toEqual(['ExecuteQuery']);

    as.validAccess = new Set(); // access token expired; the refresh token still works
    await closeMcpClient(OWNER, GROUP);
    await mcpListRemoteTools(OWNER, GROUP, binding);
    const req = as.tokenRequests.at(-1)!;
    expect(req.params.get('grant_type')).toBe('refresh_token');
    expect(req.params.get('client_secret')).toBe('ms-secret');
    expect(req.params.has('resource')).toBe(false);
    expect(binding.oauth?.status).toBe('connected');
    await closeMcpClient(OWNER, GROUP);
  });

  it('an explicit scope wins, and still gets offline_access', async () => {
    await setMcpOAuthClient(store, { scope: `${origin}/Dataset.Read.All` });
    expect(store.secrets.has('oauth-tokens')).toBe(true); // a scope edit keeps the connection
    const flow = await startMcpOAuth(store, { redirectUri: REDIRECT });
    if (!('authorizeUrl' in flow)) {
      // Live tokens short-circuit the flow; drop them to see the URL.
      store.secrets.delete('oauth-tokens');
      const again = await startMcpOAuth(store, { redirectUri: REDIRECT });
      if (!('authorizeUrl' in again)) throw new Error('expected a redirect flow');
      expect(new URL(again.authorizeUrl).searchParams.get('scope')).toBe(
        `${origin}/Dataset.Read.All offline_access`,
      );
      return;
    }
    expect(new URL(flow.authorizeUrl).searchParams.get('scope')).toBe(
      `${origin}/Dataset.Read.All offline_access`,
    );
  });

  it('with no Microsoft app configured: teaching error, no silent pending', async () => {
    fresh({ client: { source: 'microsoft' } });
    msApp = null;
    await expect(startMcpOAuth(store, { redirectUri: REDIRECT })).rejects.toThrow(
      /Settings → Microsoft has none configured/,
    );
    expect(binding.oauth?.pending).toBeUndefined();
    expect(binding.oauth?.lastError).toMatch(/Settings → Microsoft/);
  });

  it('refuses to switch to the Microsoft app while none is configured', async () => {
    fresh();
    msApp = null;
    await expect(setMcpOAuthClient(store, { client: { source: 'microsoft' } })).rejects.toThrow(
      /Settings → Microsoft/,
    );
    expect(binding.oauth?.client).toBeUndefined();
  });
});

describe('a manual app', () => {
  it('is sealed in the vault and skips registration', async () => {
    fresh();
    await setMcpOAuthClient(store, {
      client: {
        source: 'manual',
        clientId: 'man-1',
        clientSecret: 's3',
        authorizationServer: `${origin}/tenant-1/v2.0`,
      },
    });
    expect(JSON.parse(store.secrets.get('oauth-client')!)).toEqual({
      client_id: 'man-1',
      client_secret: 's3',
    });
    expect(binding.oauth?.clientId).toBe('man-1');
    expect(binding.oauth?.client).toEqual({
      source: 'manual',
      authorizationServer: `${origin}/tenant-1/v2.0`,
    });
    const flow = await startMcpOAuth(store, { redirectUri: REDIRECT });
    if (!('authorizeUrl' in flow)) throw new Error('expected a redirect flow');
    const u = new URL(flow.authorizeUrl);
    expect(u.pathname).toBe('/tenant-1/oauth2/v2.0/authorize');
    expect(u.searchParams.get('client_id')).toBe('man-1');
    expect(as.registerHits).toBe(0);
  });

  it('re-sending the same app keeps the connection; switching apps drops it', async () => {
    binding = { ...binding, oauth: { ...binding.oauth!, status: 'connected' } };
    store.secrets.set('oauth-tokens', JSON.stringify({ access_token: 'x', token_type: 'Bearer' }));
    await setMcpOAuthClient(store, {
      client: {
        source: 'manual',
        clientId: 'man-1',
        authorizationServer: `${origin}/tenant-1/v2.0`,
      },
    });
    expect(store.secrets.has('oauth-tokens')).toBe(true);
    expect(binding.oauth?.status).toBe('connected');

    await setMcpOAuthClient(store, { client: { source: 'microsoft' } });
    expect(store.secrets.has('oauth-tokens')).toBe(false);
    expect(store.secrets.has('oauth-client')).toBe(false); // no stale app shadows the borrowed one
    expect(binding.oauth?.clientId).toBeUndefined();
    expect(binding.oauth?.status).toBe('needs_reconnect');
    expect(binding.oauth?.client).toEqual({ source: 'microsoft' });

    await setMcpOAuthClient(store, { client: { source: 'dynamic' } });
    expect(binding.oauth?.client).toBeUndefined();
  });
});

describe('a provider error on the callback', () => {
  it('clears pending and records the reason with its cure', async () => {
    fresh({ client: { source: 'microsoft' } });
    await startMcpOAuth(store, { redirectUri: REDIRECT });
    const msg = await abandonMcpOAuth(
      store,
      'AADSTS65001: The user or administrator has not consented',
    );
    expect(msg).toMatch(/grant admin consent/);
    expect(binding.oauth?.pending).toBeUndefined();
    expect(binding.oauth?.lastError).toMatch(/AADSTS65001/);
    expect(store.secrets.has('oauth-verifier')).toBe(false);
  });
});

describe('a failed code exchange', () => {
  it('keeps the real Entra reason past the SDK retry, with its cure', async () => {
    fresh({ client: { source: 'microsoft' } });
    await startMcpOAuth(store, { redirectUri: REDIRECT });
    // What Entra says when the callback URL sits under "Mobile and desktop".
    as.tokenError = {
      error: 'invalid_client',
      error_description:
        "AADSTS700025: Client is public so neither 'client_assertion' nor 'client_secret' should be presented.",
    };
    await expect(completeMcpOAuth(store, { code: AUTH_CODE })).rejects.toThrow(
      /AADSTS700025[\s\S]*'Web' platform/,
    );
    expect(binding.oauth?.pending).toBeUndefined();
    expect(binding.oauth?.status).toBe('pending');
    expect(binding.oauth?.lastError).toMatch(/AADSTS700025/);
    expect(store.secrets.has('oauth-verifier')).toBe(false);
  });
});
