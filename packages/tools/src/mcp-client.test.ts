/**
 * End-to-end test of the connector client against a REAL MCP server running
 * in-process over streamable HTTP on 127.0.0.1 (no external network). Proves
 * the whole path: vault-resolved auth header → transport → list/call →
 * result mapping — the same wire an actual connector uses.
 *
 * The SSRF guard is stubbed because it (correctly) blocks loopback in
 * production; its own behaviour is covered by ssrf-guard tests.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./ssrf-guard', () => ({ assertFetchableUrl: async () => {} }));
vi.mock('@mantle/api-keys', () => ({
  getApiKey: async (_owner: string, service: string, label: string) =>
    service === 'testsvc' && label === 'default' ? 'test-key-123' : null,
}));

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolGroupMcpBinding } from '@mantle/db';
import { closeMcpClient, mcpCallRemoteTool, mcpListRemoteTools } from './mcp-client';

const OWNER = 'owner-1';
const GROUP = 'mcp-testsvc';
const seenAuth: Array<string | undefined> = [];

function buildRemoteServer(): Server {
  const server = new Server(
    { name: 'test-remote', version: '9.9.9' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo the message back.',
        inputSchema: {
          type: 'object',
          properties: { msg: { type: 'string' } },
          required: ['msg'],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'echo') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ echoed: req.params.arguments?.msg }) }],
      };
    }
    return { content: [{ type: 'text', text: 'no such tool' }], isError: true };
  });
  return server;
}

let httpServer: http.Server;
let binding: ToolGroupMcpBinding;

beforeAll(async () => {
  // Stateless mode: a fresh MCP server + transport per request, JSON responses.
  httpServer = http.createServer((req, res) => {
    void (async () => {
      seenAuth.push(req.headers.authorization);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
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
  const { port } = httpServer.address() as AddressInfo;
  binding = { url: `http://127.0.0.1:${port}/mcp`, secretRef: 'testsvc/default' };
});

afterAll(async () => {
  await closeMcpClient(OWNER, GROUP);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('mcp-client against an in-process streamable-HTTP server', () => {
  it('lists remote tools with the vault credential in the auth header', async () => {
    const { tools, serverInfo } = await mcpListRemoteTools(OWNER, GROUP, binding);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'echo', description: 'Echo the message back.' });
    expect(serverInfo).toEqual({ name: 'test-remote', version: '9.9.9' });
    expect(seenAuth.filter(Boolean).length).toBeGreaterThan(0);
    expect(new Set(seenAuth.filter(Boolean))).toEqual(new Set(['Bearer test-key-123']));
  });

  it('calls a remote tool and maps text content + the secret map', async () => {
    const res = await mcpCallRemoteTool(OWNER, GROUP, binding, 'echo', { msg: 'hi' });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toEqual({ echoed: 'hi' });
    expect(res.secrets.get('testsvc/default')).toBe('test-key-123');
  });

  it('surfaces a remote isError result as isError, not a throw', async () => {
    const res = await mcpCallRemoteTool(OWNER, GROUP, binding, 'nope', {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain('no such tool');
  });

  it('fails with a teaching error when the vault entry is missing', async () => {
    await closeMcpClient(OWNER, 'mcp-other');
    await expect(
      mcpListRemoteTools(OWNER, 'mcp-other', { ...binding, secretRef: 'missing/default' }),
    ).rejects.toThrow(/not found in the API-key vault/);
  });
});
