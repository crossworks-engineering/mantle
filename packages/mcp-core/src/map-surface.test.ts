/**
 * The tool map over the real SDK (map-surface.ts): what a client on the map
 * is listed, which call tool each tool takes, and the refusals of a call
 * through the wrong one. No call here reaches a tool's handler on the full
 * surface (that needs the database); the routing is pinned on a map of
 * stand-in tools instead.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { RISK_CALL_SLUGS, policyRiskClass, namedToolPolicy } from '@mantle/tools';

import { registerMantleTools } from './build-server';
import { jsonReply } from './gated-tools';
import { MCP_MAP_INSTRUCTIONS, McpToolMap, wantsToolMap, type McpMapEntry } from './map-surface';
import { MANTLE_MCP_INSTRUCTIONS } from './build-server';
import { toolInputSchema } from './register/tool-input';
import { z } from 'zod';

const CALLS = Object.values(RISK_CALL_SLUGS);

async function connect(register: (server: McpServer) => void) {
  const server = new McpServer({ name: 'mantle', version: '0.0.1' });
  register(server);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'map-surface-test', version: '0' });
  await client.connect(clientSide);
  return client;
}

/** A client of the full surface, on the map or not. */
function surface(onMap: boolean) {
  return connect((server) => {
    const map = onMap
      ? new McpToolMap(`${MANTLE_MCP_INSTRUCTIONS} ${MCP_MAP_INSTRUCTIONS}`)
      : undefined;
    registerMantleTools(server, 'owner-1', { transport: 'stdio', ...(map ? { map } : {}) });
    map?.register(server);
  });
}

type Reply = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const text = (r: unknown) => ((r as Reply).content[0]?.text ?? '') as string;

describe('the tool map on the full surface', () => {
  let client: Client | null = null;
  afterEach(async () => {
    await client?.close();
    client = null;
  });

  it('lists reads in full, tool_help and the four call tools, and nothing else', async () => {
    client = await surface(true);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const c of ['tool_help', ...CALLS]) expect(names).toContain(c);
    const direct = tools.filter((t) => !['tool_help', ...CALLS].includes(t.name));
    expect(direct.length).toBeGreaterThan(5);
    expect(direct.length).toBeLessThan(30);
    for (const t of direct) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    // Named by the instructions, so listed in full.
    for (const n of ['search', 'recall_match', 'recall_index', 'recall_open']) {
      expect(names).toContain(n);
    }
    expect(tools.find((t) => t.name === 'tool_read')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'tool_send')?.annotations?.openWorldHint).toBe(true);
    expect(tools.find((t) => t.name === 'tool_delete')?.annotations?.destructiveHint).toBe(true);
  });

  it('every tool of the full list is reachable, through the call tool of its class', async () => {
    const full = await surface(false);
    const all = (await full.listTools()).tools.map((t) => t.name);
    await full.close();
    client = await surface(true);
    const listed = new Set((await client.listTools()).tools.map((t) => t.name));
    const mapped = all.filter((n) => !listed.has(n));
    expect(mapped.length).toBeGreaterThan(200);
    for (let i = 0; i < mapped.length; i += 15) {
      const names = mapped.slice(i, i + 15);
      const r = await client.callTool({ name: 'tool_help', arguments: { names } });
      const cards = JSON.parse(text(r)).tools as Array<{ name: string; call_with: string }>;
      expect(cards.map((c) => c.name).sort()).toEqual([...names].sort());
      for (const c of cards) {
        const policy = namedToolPolicy(c.name)?.policy;
        if (policy) expect(c.call_with, c.name).toBe(RISK_CALL_SLUGS[policyRiskClass(policy)]);
        else expect(CALLS, c.name).toContain(c.call_with);
      }
    }
  });

  it('each call tool names its own tools in its description', async () => {
    client = await surface(true);
    const { tools } = await client.listTools();
    const desc = (n: string) => tools.find((t) => t.name === n)?.description ?? '';
    expect(desc('tool_send')).toContain('email');
    expect(desc('tool_delete')).toContain('contact_delete');
    expect(desc('tool_read')).not.toContain('email_send');
  });

  it('refuses a call through the wrong call tool, naming the right one', async () => {
    client = await surface(true);
    const r = await client.callTool({
      name: 'tool_read',
      arguments: { name: 'email_send', arguments: {} },
    });
    expect((r as Reply).isError).toBe(true);
    expect(text(r)).toContain("'email_send' is a send tool, not read: call it with tool_send");
    const d = await client.callTool({
      name: 'tool_write',
      arguments: { name: 'contact_delete', arguments: {} },
    });
    expect(text(d)).toContain('call it with tool_delete');
  });

  it('answers a name that is no tool with near names and their call tools', async () => {
    client = await surface(true);
    const r = await client.callTool({
      name: 'tool_send',
      arguments: { name: 'email_sned', arguments: {} },
    });
    expect((r as Reply).isError).toBe(true);
    expect(text(r)).toContain('email_send (tool_send)');
  });

  it('answers wrong arguments with the schema, before the tool runs', async () => {
    client = await surface(true);
    const r = await client.callTool({
      name: 'tool_read',
      arguments: { name: 'contact_get', arguments: {} },
    });
    expect((r as Reply).isError).toBe(true);
    expect(text(r)).toContain("Wrong arguments for 'contact_get'");
    expect(text(r)).toContain('input schema');
  });
});

describe('the call tools run the tool they name', () => {
  const entry = (name: string, cls: McpMapEntry['cls'], seen: unknown[]): McpMapEntry => ({
    name,
    description: `Stand-in ${name}.`,
    inputSchema: toolInputSchema({ id: z.string() }),
    respond: async (args) => {
      seen.push([name, args]);
      return jsonReply({ ran: name });
    },
    cls,
    source: 'builtin',
  });

  it('a call through its own class runs the handler with the checked arguments', async () => {
    const seen: unknown[] = [];
    const client = await connect((server) => {
      const map = new McpToolMap('');
      map.add(entry('thing_get', 'read', seen));
      map.add(entry('thing_update', 'write', seen));
      map.add(entry('thing_delete', 'delete', seen));
      map.add(entry('thing_post', 'send', seen));
      map.register(server);
    });
    const r = await client.callTool({
      name: 'tool_delete',
      arguments: { name: 'thing_delete', arguments: { id: 'x1' } },
    });
    expect(JSON.parse(text(r))).toEqual({ ran: 'thing_delete' });
    expect(seen).toEqual([['thing_delete', { id: 'x1' }]]);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['tool_delete', 'tool_help', 'tool_read', 'tool_send', 'tool_write']);
    await client.close();
  });

  it('a class with no tool gets no call tool', async () => {
    const client = await connect((server) => {
      const map = new McpToolMap('');
      map.add(entry('thing_get', 'read', []));
      map.register(server);
    });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['tool_help', 'tool_read']);
    await client.close();
  });
});

describe('wantsToolMap', () => {
  it('the URL picks: map or full', () => {
    expect(wantsToolMap('https://brain.example/api/mcp?tools=map')).toBe(true);
    expect(wantsToolMap('https://brain.example/api/mcp?tools=full')).toBe(false);
  });

  it("without a choice, the box's switch (off by default)", () => {
    expect(wantsToolMap('https://brain.example/api/mcp')).toBe(false);
    expect(wantsToolMap('not a url')).toBe(false);
  });
});
