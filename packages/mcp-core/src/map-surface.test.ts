/**
 * The tool map over the real SDK (map-surface.ts): what a client on the map
 * is listed, which call tool each tool takes, and the refusals of a call
 * through the wrong one. No call here reaches a tool's handler on the full
 * surface (that needs the database); the routing is pinned on a map of
 * stand-in tools instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { RISK_CALL_SLUGS, policyRiskClass, namedToolPolicy, type RiskClass } from '@mantle/tools';

import { registerMantleTools } from './build-server';
import { registerPreparedTools } from './login-surface';
import { SCOPE_AREAS } from '@mantle/db/viewer';
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

  it('lists the call tools that change something first, then tool_read and tool_help, then the direct reads', async () => {
    client = await surface(true);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.slice(0, 5)).toEqual([
      'tool_write',
      'tool_delete',
      'tool_send',
      'tool_read',
      'tool_help',
    ]);
    const direct = names.slice(5);
    expect(direct).toContain('search');
    expect(direct).toEqual([...direct].sort());
  });

  it.each([
    ['stdio', (s: McpServer) => registerMantleTools(s, 'owner-1', { transport: 'stdio' })],
    ['HTTP', (s: McpServer) => registerMantleTools(s, 'owner-1', { transport: 'http' })],
    [
      'HTTP for a login (registerPreparedTools)',
      (s: McpServer) =>
        registerPreparedTools(s, {
          kind: 'owner',
          caller: {
            role: 'admin',
            anchorId: 'owner-1',
            loginId: 'login-1',
            via: 'oauth',
            write: true,
          },
          view: { holdsAdmin: true, areas: new Set(SCOPE_AREAS) },
          privateWs: null,
          connectors: [],
        }),
    ],
  ])(
    'the full list (%s): every write, then every delete, then every send, then the reads, by name inside each',
    async (_how, register) => {
      // Each tool's class, as the one registration hands it to the list.
      const add = vi.spyOn(McpToolMap.prototype, 'add');
      try {
        client = await connect(register);
        const seen = add.mock.calls.map(([e]) => [e.name, e.cls] as [string, RiskClass]);
        const names = (await client.listTools()).tools.map((t) => t.name);
        const rank = (c: RiskClass) => ['write', 'delete', 'send', 'read'].indexOf(c);
        const expected = [...seen]
          .sort(([a, ca], [b, cb]) => rank(ca) - rank(cb) || (a < b ? -1 : 1))
          .map(([n]) => n);
        expect(new Set(seen.map(([, c]) => c))).toEqual(
          new Set(['write', 'delete', 'send', 'read']),
        );
        expect(names).toEqual(expected);
      } finally {
        add.mockRestore();
      }
    },
  );

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

  it('a tool on the map is still called by its own name; a name not handed over is not found', async () => {
    const seen: unknown[] = [];
    const client = await connect((server) => {
      const map = new McpToolMap('');
      map.add(entry('thing_get', 'read', seen));
      map.add(entry('thing_post', 'send', seen));
      map.register(server);
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('thing_post');
    const r = await client.callTool({ name: 'thing_post', arguments: { id: 'x2' } });
    expect(JSON.parse(text(r))).toEqual({ ran: 'thing_post' });
    expect(seen).toEqual([['thing_post', { id: 'x2' }]]);
    await expect(client.callTool({ name: 'thing_put', arguments: { id: 'x' } })).rejects.toThrow(
      /Tool thing_put not found/,
    );
    await client.close();
  });

  it("the map's tools/list writes each tool as the SDK's own tools/list does", async () => {
    const fill = (map: McpToolMap) => {
      map.add(entry('thing_get', 'read', []));
      map.add(entry('thing_update', 'write', []));
      map.add(entry('thing_post', 'send', []));
      // A plain zod schema too: written with the draft the SDK's list asks for.
      map.add({
        ...entry('calculate', 'read', []),
        inputSchema: z.object({ x: z.number() }) as never,
        annotations: {
          title: 'calculate',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      });
    };
    const onMap = await connect((server) => {
      const map = new McpToolMap('');
      fill(map);
      map.register(server);
    });
    const mapList = (await onMap.listTools()).tools;
    await onMap.close();
    // The same registrations with the SDK's own tools/list left in place:
    // the map's replacement of it is not passed on.
    const sdkOwn = await connect((server) => {
      let replaced = false;
      const low = new Proxy(server.server, {
        get(target, key) {
          if (key === 'removeRequestHandler') {
            return (method: string) => {
              if (method === 'tools/list') replaced = true;
              else target.removeRequestHandler(method as never);
            };
          }
          if (key === 'setRequestHandler' && replaced) return () => undefined;
          const v = Reflect.get(target, key);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      const outer = new Proxy(server, {
        get: (target, key) => (key === 'server' ? low : Reflect.get(target, key)),
      });
      const map = new McpToolMap('');
      fill(map);
      map.register(outer as McpServer);
      expect(replaced).toBe(true);
    });
    const sdkList = (await sdkOwn.listTools()).tools;
    await sdkOwn.close();
    expect(sdkList.map((t) => t.name)).toContain('thing_post');
    expect(mapList.map((t) => t.name)).toEqual([
      'tool_write',
      'tool_send',
      'tool_read',
      'tool_help',
      'calculate',
    ]);
    // Each definition as the SDK writes it (the order is the map's own).
    const byName = (l: typeof mapList) => [...l].sort((a, b) => (a.name < b.name ? -1 : 1));
    const listed = new Set(mapList.map((t) => t.name));
    expect(byName(mapList)).toEqual(byName(sdkList.filter((t) => listed.has(t.name))));
  });

  it('a second tool of the same name throws, as a second registerTool does', () => {
    const map = new McpToolMap('');
    map.add(entry('thing_get', 'read', []));
    expect(() => map.add(entry('thing_get', 'read', []))).toThrow(/already registered/);
  });

  it('the map lists in list order whatever order the tools came in', async () => {
    const client = await connect((server) => {
      const map = new McpToolMap('use thing_list and thing_get');
      for (const [n, c] of [
        ['thing_list', 'read'],
        ['thing_post', 'send'],
        ['thing_get', 'read'],
        ['thing_drop', 'delete'],
        ['thing_find', 'read'],
        ['thing_update', 'write'],
      ] as const) {
        map.add(entry(n, c, []));
      }
      map.register(server);
    });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      'tool_write',
      'tool_delete',
      'tool_send',
      'tool_read',
      'tool_help',
      'thing_get',
      'thing_list',
    ]);
    await client.close();
  });

  it('the full list keeps a tool named like a map tool, and lists by class then name', async () => {
    const client = await connect((server) => {
      const list = McpToolMap.fullList();
      for (const [n, c] of [
        ['thing_list', 'read'],
        ['tool_help', 'read'],
        ['thing_post', 'send'],
        ['thing_drop', 'delete'],
        ['thing_update', 'write'],
        ['thing_add', 'write'],
      ] as const) {
        expect(list.add(entry(n, c, []))).toBe(true);
      }
      list.register(server);
    });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      'thing_add',
      'thing_update',
      'thing_drop',
      'thing_post',
      'thing_list',
      'tool_help',
    ]);
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

  it("a linked brain's connection is never on the map: its peer tools call by name", () => {
    expect(wantsToolMap('https://brain.example/api/mcp?tools=map', 'peer')).toBe(false);
    expect(wantsToolMap('https://brain.example/api/mcp?tools=map', 'login')).toBe(true);
  });

  it("without a choice, the box's switch (off by default)", () => {
    expect(wantsToolMap('https://brain.example/api/mcp')).toBe(false);
    expect(wantsToolMap('not a url')).toBe(false);
  });
});
