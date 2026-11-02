/**
 * A hand-written MCP definition's call through the one registration
 * (gated-tools.ts; A5 step 4 fix round 1, LOW-1) names what a builtin's
 * names: the `workspace` argument of a create (the gate's step 6 reads it
 * as the call's `ask`) and the owner the pre-run checks read (the item
 * pre-check, a key's change to shared content). No definition creates
 * today; a definition entry named like a builtin create takes its policy,
 * which is how a future one would.
 */
import { describe, expect, it, vi } from 'vitest';

// No database: the brain reads as not on workspaces, so the call runs as is
// (mcp-scope.ts).
// No database: each call runs as it is, with no scope entered (the scope
// entry and the Admin view stood in).
vi.mock('./mcp-scope', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mcpScopeEntry:
    () =>
    <T>(_writes: boolean, fn: () => Promise<T>) =>
      fn(),
  mcpAdminView: async () => null,
}));
// The call log's rows, as the one registration hands them over.
vi.mock('./call-log', () => ({ logMcpCall: vi.fn() }));

import { z } from 'zod';
import type { CallInput, GateCaller, GatePolicy, PreRunCheck } from '@mantle/db';
import { registerGatedTool, type McpGate } from './gated-tools';
import { defaultMcpGate } from './gate-policy';
import { MCP_TOOL_DEFS } from './mcp-defs';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { McpToolMap } from './map-surface';
import { logMcpCall } from './call-log';

type Handler = (args: unknown, extra: unknown) => Promise<unknown>;

/** Register a definition named `name` whose pre-run check records the
 *  call and refuses it (nothing past the check runs). */
function probe(name: string): { call: Handler; seen: CallInput[] } {
  const seen: CallInput[] = [];
  const base = defaultMcpGate('owner-1');
  const preRun: PreRunCheck = async (_c, _p, _r, call) => {
    seen.push(call);
    return 'stopped by the probe';
  };
  const gate: McpGate = Object.freeze({
    ...base,
    callerFor: async (policy: GatePolicy): Promise<GateCaller> => ({
      ...(await base.callerFor(policy)),
      // No create home rule: step 6 reads the ask, and needs no database.
      createHome: null,
      preRun,
    }),
  });
  let cb: Handler | undefined;
  const fake = { registerTool: (_n: string, _c: unknown, h: Handler) => (cb = h) };
  const listed = registerGatedTool(fake as never, gate, 'owner-1', {
    kind: 'definition',
    name,
    description: 'd',
    shape: { title: z.string().optional(), folder_id: z.string().optional() },
    run: async () => ({ content: [] }),
  });
  expect(listed).toBe(true);
  return { call: cb!, seen };
}

describe('a definition’s call names its ask and its owner (fix round 1, LOW-1)', () => {
  it('the pre-run checks read the owner', async () => {
    const { call, seen } = probe('folder_rename');
    const res = (await call({ folder_id: 'f1' }, {})) as { content: Array<{ text: string }> };
    expect(res.content[0]!.text).toBe('Error: stopped by the probe');
    expect(seen[0]!.context).toEqual({ ownerId: 'owner-1' });
    expect(seen[0]!.args).toEqual({ folder_id: 'f1' });
    // Not a create: no ask.
    expect(seen[0]!.ask ?? null).toBeNull();
  });

  it('a create keeps its workspace argument as the call’s ask', async () => {
    const { call, seen } = probe('page_create');
    await call({ title: 't', workspace: 'Team A' }, {});
    expect(seen[0]!.ask).toEqual({ from: 'argument', workspace: 'Team A' });
    // The argument is the gate's, not the body's.
    expect(seen[0]!.args).toEqual({ title: 't' });
    expect(seen[0]!.context).toEqual({ ownerId: 'owner-1' });
  });

  it('no definition today creates or changes content others read', () => {
    for (const def of MCP_TOOL_DEFS) {
      expect(def.policy.creates ?? null, def.slug).toBeNull();
      expect(def.policy.keySharedContent ?? false, def.slug).toBe(false);
    }
  });
});

describe('a call through the tool map runs the gated path (map-surface.ts)', () => {
  it('the pre-run checks see the call, its owner and a create’s workspace ask', async () => {
    const seen: CallInput[] = [];
    const base = defaultMcpGate('owner-1');
    const gate: McpGate = Object.freeze({
      ...base,
      callerFor: async (policy: GatePolicy): Promise<GateCaller> => ({
        ...(await base.callerFor(policy)),
        createHome: null,
        preRun: async (_c, _p, _r, call) => {
          seen.push(call);
          return 'stopped by the probe';
        },
      }),
    });
    const map = new McpToolMap('');
    const server = new McpServer({ name: 'mantle', version: '0' });
    registerGatedTool(
      server,
      gate,
      'owner-1',
      {
        kind: 'definition',
        name: 'page_create',
        description: 'd',
        shape: { title: z.string().optional() },
        run: async () => ({ content: [] }),
      },
      map,
    );
    map.register(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'gated-map-test', version: '0' });
    await client.connect(b);
    const res = (await client.callTool({
      name: 'tool_write',
      arguments: { name: 'page_create', arguments: { title: 't', workspace: 'Team A' } },
    })) as { content: Array<{ text: string }> };
    await client.close();
    expect(res.content[0]!.text).toBe('Error: stopped by the probe');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ask).toEqual({ from: 'argument', workspace: 'Team A' });
    expect(seen[0]!.args).toEqual({ title: 't' });
    expect(seen[0]!.context).toEqual({ ownerId: 'owner-1' });
  });
});

describe('a client that cached the full list calls a tool by its own name on the map', () => {
  // One tool per class, none of them a core read: on the map each is
  // reached through a call tool, and none is listed by its own name.
  const NAMES = {
    read: 'contact_get',
    write: 'contact_update',
    delete: 'contact_delete',
    send: 'email_send',
  };

  /** A connection with the four tools, on the map or not, whose pre-run
   *  check records each call and refuses it (nothing past the check runs,
   *  so no database). */
  async function connection(onMap: boolean) {
    const seen: CallInput[] = [];
    const base = defaultMcpGate('owner-1');
    const gate: McpGate = Object.freeze({
      ...base,
      callerFor: async (policy: GatePolicy): Promise<GateCaller> => ({
        ...(await base.callerFor(policy)),
        createHome: null,
        preRun: async (_c, _p, _r, call) => {
          seen.push(call);
          return 'stopped by the probe';
        },
      }),
    });
    const map = onMap ? new McpToolMap('') : undefined;
    const server = new McpServer({ name: 'mantle', version: '0' });
    for (const name of Object.values(NAMES)) {
      const listed = registerGatedTool(
        server,
        gate,
        'owner-1',
        {
          kind: 'definition',
          name,
          description: `d ${name}`,
          shape: { id: z.string() },
          run: async () => ({ content: [] }),
        },
        map,
      );
      expect(listed, name).toBe(true);
    }
    map?.register(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'cached-names-test', version: '0' });
    await client.connect(b);
    return { client, seen };
  }

  /** The call log rows written so far, less the time each call took. */
  const logged = () => vi.mocked(logMcpCall).mock.calls.map(([row]) => ({ ...row, durationMs: 0 }));

  it('a read, a write, a delete and a send run as on the full list, with the same call log', async () => {
    vi.mocked(logMcpCall).mockClear();
    const full = await connection(false);
    const fullReplies = [];
    for (const name of Object.values(NAMES)) {
      fullReplies.push(await full.client.callTool({ name, arguments: { id: `id-${name}` } }));
    }
    await full.client.close();
    const fullLog = logged();
    expect(fullLog.map((r) => r.tool)).toEqual(Object.values(NAMES));

    vi.mocked(logMcpCall).mockClear();
    const onMap = await connection(true);
    const listed = (await onMap.client.listTools()).tools.map((t) => t.name);
    expect(listed.sort()).toEqual([
      'tool_delete',
      'tool_help',
      'tool_read',
      'tool_send',
      'tool_write',
    ]);
    const mapReplies = [];
    for (const name of Object.values(NAMES)) {
      mapReplies.push(await onMap.client.callTool({ name, arguments: { id: `id-${name}` } }));
    }
    await onMap.client.close();

    expect(mapReplies).toEqual(fullReplies);
    expect(mapReplies[0]).toEqual({
      content: [{ type: 'text', text: 'Error: stopped by the probe' }],
      isError: true,
    });
    expect(onMap.seen).toEqual(full.seen);
    expect(onMap.seen.map((c) => c.args)).toEqual(
      Object.values(NAMES).map((n) => ({ id: `id-${n}` })),
    );
    expect(logged()).toEqual(fullLog);
  });

  it('the arguments are checked as on the full list', async () => {
    const full = await connection(false);
    const fullReply = await full.client.callTool({ name: NAMES.write, arguments: {} });
    await full.client.close();
    const onMap = await connection(true);
    const mapReply = await onMap.client.callTool({ name: NAMES.write, arguments: {} });
    await onMap.client.close();
    expect((mapReply as { isError?: boolean }).isError).toBe(true);
    expect(mapReply).toEqual(fullReply);
    expect(onMap.seen).toEqual([]);
  });

  it('a name the gate did not hand over stays not found', async () => {
    const onMap = await connection(true);
    await expect(onMap.client.callTool({ name: 'contact_create', arguments: {} })).rejects.toThrow(
      /Tool contact_create not found/,
    );
    await onMap.client.close();
  });
});
