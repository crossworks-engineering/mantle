/**
 * End-to-end test of the connector OAuth client against a fake authorization
 * server + OAuth-protected MCP server running in-process (no external
 * network): RFC 9728 discovery → dynamic registration → PKCE start →
 * code exchange → authorized tool calls → silent refresh → the
 * needs_reconnect teaching path. Uses the injectable store, so no database.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./ssrf-guard', () => ({ assertFetchableUrl: async () => {} }));

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolGroupMcpBinding } from '@mantle/db';
import {
  closeMcpClient,
  mcpCallRemoteTool,
  mcpListRemoteTools,
  setMcpOAuthStoreFactoryForTests,
} from './mcp-client';
import { completeMcpOAuth, startMcpOAuth, type McpOAuthStore } from './mcp-oauth';

const OWNER = 'owner-1';
const GROUP = 'mcp-oauthtest';
const AUTH_CODE = 'test-auth-code';

/** Mutable server-side auth state. */
const authState = {
  validAccess: new Set(['never']),
  refreshWorks: true,
  issued: [] as string[],
  seenBearer: [] as string[],
};

function issueTokens(n: number) {
  const access = `access-${n}`;
  const refresh = `refresh-${n}`;
  authState.validAccess = new Set([access]);
  authState.issued.push(access);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refresh,
  };
}

function buildRemoteServer(): Server {
  const server = new Server(
    { name: 'oauth-remote', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'ping', description: 'Ping.', inputSchema: { type: 'object' } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  return server;
}

let httpServer: http.Server;
let origin: string;
let binding: ToolGroupMcpBinding;
let tokenGrantCount = 0;

/** In-memory store (the db-backed one is exercised in production). */
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

      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (url.pathname === '/register') {
        const body = JSON.parse(await readBody()) as Record<string, unknown>;
        return json(
          {
            client_id: 'client-abc',
            redirect_uris: body.redirect_uris,
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            client_name: body.client_name,
          },
          201,
        );
      }
      if (url.pathname === '/token') {
        const params = new URLSearchParams(await readBody());
        if (params.get('grant_type') === 'authorization_code') {
          if (params.get('code') !== AUTH_CODE || !params.get('code_verifier')) {
            return json({ error: 'invalid_grant' }, 400);
          }
          return json(issueTokens(++tokenGrantCount));
        }
        if (params.get('grant_type') === 'refresh_token') {
          if (!authState.refreshWorks) return json({ error: 'invalid_grant' }, 400);
          if (params.get('refresh_token') !== `refresh-${tokenGrantCount}`) {
            return json({ error: 'invalid_grant' }, 400);
          }
          return json(issueTokens(++tokenGrantCount));
        }
        return json({ error: 'unsupported_grant_type' }, 400);
      }

      // The protected MCP endpoint.
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (bearer) authState.seenBearer.push(bearer);
      if (!authState.validAccess.has(bearer)) {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        });
        return res.end();
      }
      const raw = await readBody();
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await buildRemoteServer().connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  binding = { url: `${origin}/mcp`, oauth: { enabled: true, status: 'pending' } };
  store = memoryStore();
  setMcpOAuthStoreFactoryForTests(() => store);
});

afterAll(async () => {
  await closeMcpClient(OWNER, GROUP);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('MCP connector OAuth end to end', () => {
  it('start: discovers, registers, and hands back the authorization URL', async () => {
    const flow = await startMcpOAuth(store, { redirectUri: 'http://127.0.0.1:9/cb' });
    if (!('authorizeUrl' in flow)) throw new Error('expected a redirect flow');
    const u = new URL(flow.authorizeUrl);
    expect(u.pathname).toBe('/authorize');
    expect(u.searchParams.get('client_id')).toBe('client-abc');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('state')).toBe(flow.state);
    expect(binding.oauth?.pending?.state).toBe(flow.state);
    expect(binding.oauth?.clientId).toBe('client-abc');
    expect(store.secrets.get('oauth-verifier')).toBeTruthy();
  });

  it('complete: exchanges the code, seals tokens, clears pending', async () => {
    await completeMcpOAuth(store, { code: AUTH_CODE });
    expect(binding.oauth?.status).toBe('connected');
    expect(binding.oauth?.pending).toBeUndefined();
    expect(store.secrets.has('oauth-verifier')).toBe(false);
    const tokens = JSON.parse(store.secrets.get('oauth-tokens')!) as { access_token: string };
    expect(tokens.access_token).toBe('access-1');
  });

  it('calls the protected server with the stored access token', async () => {
    const { tools } = await mcpListRemoteTools(OWNER, GROUP, binding);
    expect(tools.map((t) => t.name)).toEqual(['ping']);
    const res = await mcpCallRemoteTool(OWNER, GROUP, binding, 'ping', {});
    expect(res.isError).toBe(false);
    expect(res.text).toBe('pong');
    expect(authState.seenBearer).toContain('access-1');
  });

  it('silently refreshes when the access token dies', async () => {
    authState.validAccess = new Set(); // access-1 revoked; refresh-1 still good
    await closeMcpClient(OWNER, GROUP);
    const res = await mcpCallRemoteTool(OWNER, GROUP, binding, 'ping', {});
    expect(res.isError).toBe(false);
    const tokens = JSON.parse(store.secrets.get('oauth-tokens')!) as { access_token: string };
    expect(tokens.access_token).toBe('access-2');
    expect(binding.oauth?.status).toBe('connected');
  });

  it('marks needs_reconnect with a teaching error when refresh dies too', async () => {
    authState.validAccess = new Set();
    authState.refreshWorks = false;
    await closeMcpClient(OWNER, GROUP);
    await expect(mcpListRemoteTools(OWNER, GROUP, binding)).rejects.toThrow(
      /re-authorize|reconnect|authorization/i,
    );
    expect(binding.oauth?.status).toBe('needs_reconnect');
  });
});
