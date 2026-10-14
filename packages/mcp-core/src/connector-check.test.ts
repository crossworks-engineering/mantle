/**
 * A connection that only reads calls a connector tool an Admin marked
 * read-only with only the inputs it was marked with, in any scope (A5 step
 * 5 fix round 1, L2). Since Q1 a read-only key or peer lists and calls a
 * marked tool; dispatch applies the mark below the owner and in a workspace
 * scope, but not on an owner surface outside one, which a read-only admin
 * key or peer is. The MCP connector check (connectorCheck, the call's
 * pre-run slot) applies it for any caller whose `write` is off. The
 * connector's workspace rule is stood in (it reads the database).
 *
 * End to end (A5 step 5 fix round 2, LOW-3): an unscoped read-only key and
 * a read-only peer, registered through registerPreparedTools, call the
 * marked tool as /api/mcp does (gated-tools.ts, the gate's connector
 * check). The connector's binding and the remote call are stood in (the
 * database, the network).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/tools')>()),
  loginConnectorRefused: vi.fn(async () => null),
}));
const h = vi.hoisted(() => ({
  /** The arguments each remote call was made with. */
  remote: [] as Record<string, unknown>[],
  /** The connector's binding (tool_groups), as dispatch reads it. */
  group: {
    slug: 'mcp-crm',
    enabled: true,
    configuredBy: null,
    integration: { mcp: { url: 'https://crm.example.test/mcp' } },
  },
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  // No database: the brain reads as not on workspaces, so the connection
  // is unscoped (mcp-scope.ts).
  brainOnWorkspacesNow: async () => false,
  // The connector's binding and its remote call; the call's audit row is
  // best effort, never read here.
  asSystem: vi.fn(async (_fn: unknown, reason?: string) => {
    if (reason === 'connector-binding') return [h.group];
    if (reason === 'connector-call') return { text: '{"rows":[]}', secrets: [] };
    return undefined;
  }),
}));

import type { Tool } from '@mantle/db';
import { externalAccessToolSig } from '@mantle/tools';
import { connectorCheck, registerPreparedTools, type McpCaller } from './login-surface';

const list = {
  slug: 'mcp_crm_contacts_list',
  description: 'The crm contacts list.',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  handler: { kind: 'mcp', group: 'mcp-crm', toolName: 'contacts_list' },
  requiresConfirm: false,
  externalAccess: null,
} as unknown as Tool;
const marked = {
  ...list,
  externalAccess: {
    confirmedReadOnlyAt: new Date(0).toISOString(),
    by: { via: 'web' },
    handlerSig: externalAccessToolSig(list),
  },
} as Tool;

const caller = (via: McpCaller['via'], write: boolean): McpCaller => ({
  role: 'admin',
  anchorId: '99999999-9999-4999-8999-999999999999',
  loginId: '55555555-5555-4555-8555-555555555555',
  via,
  write,
});

describe('a read-only connection keeps a marked connector tool to its marked inputs (L2)', () => {
  for (const via of ['key', 'peer', 'oauth'] as const) {
    it(`a read-only ${via}: an input the tool was not marked with is refused`, async () => {
      const refused = await connectorCheck(caller(via, false))(marked, { q: 'acme', drop: true });
      expect(refused).toMatch(/marked read-only with the inputs it had then, and 'drop'/);
    });

    it(`a read-only ${via}: the marked inputs run`, async () => {
      expect(await connectorCheck(caller(via, false))(marked, { q: 'acme' })).toBeNull();
    });
  }

  it('a connection that writes is not held to the mark here (dispatch keeps its own rules)', async () => {
    expect(await connectorCheck(caller('key', true))(marked, { q: 'acme', drop: true })).toBeNull();
  });
});

describe('end to end: an unscoped read-only key or peer calls a marked connector tool through the gate (fix round 2, LOW-3)', () => {
  type Handler = (args: unknown, extra: unknown) => Promise<unknown>;
  /** The connector tool as registered for `via` (read-only, unscoped). */
  function registered(via: 'key' | 'peer'): Handler {
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _c: unknown, cb: Handler) => void handlers.set(name, cb),
    };
    registerPreparedTools(
      server as never,
      {
        kind: 'owner',
        caller: {
          ...caller(via, false),
          areas: null,
          ...(via === 'peer' ? { peerByOwner: true } : {}),
        },
        view: null,
        privateWs: null,
        connectors: [marked],
      } as never,
    );
    const cb = handlers.get(marked.slug);
    expect(cb, `${via}: the marked tool is listed`).toBeDefined();
    return cb!;
  }
  const textOf = (r: unknown) =>
    ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text).join('');

  for (const via of ['key', 'peer'] as const) {
    it(`a read-only ${via}: an undeclared input is refused before the remote call`, async () => {
      const asSystemCalls = vi.mocked((await import('@mantle/db')).asSystem);
      asSystemCalls.mockClear();
      const reply = await registered(via)({ q: 'acme', drop: true }, {});
      expect((reply as { isError?: boolean }).isError).toBe(true);
      expect(textOf(reply)).toMatch(/marked read-only with the inputs it had then, and 'drop'/);
      const reasons = asSystemCalls.mock.calls.map((c) => c[1]);
      expect(reasons).not.toContain('connector-call');
    });

    it(`a read-only ${via}: the declared inputs run`, async () => {
      const asSystemCalls = vi.mocked((await import('@mantle/db')).asSystem);
      asSystemCalls.mockClear();
      const reply = await registered(via)({ q: 'acme' }, {});
      expect((reply as { isError?: boolean }).isError ?? false, textOf(reply)).toBe(false);
      expect(textOf(reply)).toContain('rows');
      expect(asSystemCalls.mock.calls.map((c) => c[1])).toContain('connector-call');
    });
  }
});
