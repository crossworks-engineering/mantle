/**
 * One audit row for every tool write, on every surface, written by the gate
 * (A5 step 6d; gateway survey finding 6). Every dispatch entry runs a read
 * and a write through the real gate with the rows taken by a sink
 * (startCallAudit's): a read leaves none, a write exactly one, a failed
 * write none, and a write nested in another call (a recipe's step, a call a
 * handler dispatches: a delegated agent's, an approved one) is named in its
 * outer call's row, never a row of its own. An API key's MCP call leaves
 * none here: its route writes the call's row before it runs, as on main
 * (server/web/lib/mcp-auth.ts auditMcpKeyCall), so the gate writes none.
 * The rows on a real database: server/web/server/a5-call-audit.db.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loginActor,
  registerPolicySource,
  startCallAudit,
  stopCallAudit,
  type CallAuditRow,
  type GateCaller,
  type Tool,
} from '@mantle/db';

const LOGIN = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const MADE = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';

const row = (slug: string, handler?: unknown) =>
  ({ slug, handler: handler ?? { kind: 'builtin', ref: slug } }) as unknown as Tool;

vi.mock('./resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resolve')>()),
  resolveTool: async (_o: string, slug: string) => row(slug),
}));

import { dispatchTool } from './dispatch';
import {
  appBrokerCaller,
  mcpToolCaller,
  ownerWebCaller,
  pendingCaller,
  runCaller,
  turnCaller,
  type ToolCaller,
} from './gate-callers';
import { ensureGateReady } from './gate-narrowers';
import { registerBuiltin } from './registry';
import { namedToolPolicy, toGatePolicy } from './tool-policy';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

function probe(
  slug: string,
  effect: 'read' | 'write',
  handler: BuiltinToolDef['handler'],
): BuiltinToolDef {
  return {
    slug,
    name: slug,
    description: 'probe',
    inputSchema: { type: 'object', properties: {} },
    policy: { effect, spends: 'none', scope: 'any' },
    handler,
  };
}

const rows: CallAuditRow[] = [];

beforeAll(() => {
  ensureGateReady();
  // The owner MCP surface's source (@mantle/mcp-core gate-policy.ts
  // registers it; this package never imports mcp-core): a builtin's
  // declared policy, by the builtin its `mcp-tool` ref runs.
  registerPolicySource('mcp-tool', (ref) => {
    const named = namedToolPolicy(typeof ref.builtin === 'string' ? ref.builtin : ref.name);
    return named ? toGatePolicy(named.policy) : null;
  });
  registerBuiltin(probe('audit_probe_read', 'read', async () => ({ ok: true, output: {} })));
  registerBuiltin(
    probe('audit_probe_write', 'write', async () => ({ ok: true, output: { id: MADE } })),
  );
  registerBuiltin(probe('audit_probe_fail', 'write', async () => ({ ok: false, error: 'no' })));
  // A write that runs another write inside it (a delegated agent's call,
  // pending_approve running the call it approves).
  registerBuiltin(
    probe('audit_probe_outer', 'write', async (_input, ctx) => {
      const inner = await dispatchTool(row('audit_probe_write'), {}, ctx);
      return inner.ok ? { ok: true, output: { ran: true } } : inner;
    }),
  );
  startCallAudit({ sink: (r) => rows.push(r) });
});

afterAll(() => stopCallAudit());
beforeEach(() => {
  rows.length = 0;
});

const mcpGate = (via: 'oauth' | 'key' | 'stdio' | 'peer'): GateCaller =>
  Object.freeze({
    actor: loginActor(LOGIN, via === 'stdio' ? 'owner' : 'rw'),
    via,
    loginId: LOGIN,
    write: true,
    admin: null,
    // No create home here (the database names it on a real connection).
    createHome: null,
    facts: Object.freeze({
      keyAreas: null,
      riskyAllowed: [],
      audit: Object.freeze({
        peerId: via === 'peer' ? 'p1' : null,
        oauthClientId: via === 'oauth' ? 'c1' : null,
      }),
    }),
  });

type Surface = ToolHandlerContext['surface'];
const WEB: Surface = { kind: 'web', loginId: LOGIN };
const TELEGRAM = { kind: 'telegram' } as Surface;
const TEAM = { kind: 'team', loginId: LOGIN, privateReads: false } as Surface;

const allowed = (slug: string) => ({ ok: true as const, tool: row(slug) });

/** The entries: each one's caller and surface, as the entry passes them. */
const ENTRIES: Array<{
  name: string;
  caller: (slug: string) => ToolCaller;
  surface?: Surface;
  /** Rows a write leaves from the gate. */
  writeRows: number;
}> = [
  { name: 'web turn', caller: () => turnCaller(), surface: WEB, writeRows: 1 },
  { name: 'Telegram turn', caller: () => turnCaller(), surface: TELEGRAM, writeRows: 1 },
  {
    name: 'heartbeat (a turn of its agent)',
    caller: () => turnCaller(),
    surface: TEAM,
    writeRows: 1,
  },
  { name: 'run item', caller: () => runCaller(), writeRows: 1 },
  { name: 'pending approval', caller: () => pendingCaller(), surface: WEB, writeRows: 1 },
  {
    name: 'app broker (member app)',
    caller: (slug) => appBrokerCaller(TEAM!, allowed(slug)),
    surface: TEAM,
    writeRows: 1,
  },
  { name: 'dev console', caller: () => ownerWebCaller(), surface: WEB, writeRows: 1 },
  { name: 'MCP OAuth login', caller: () => mcpToolCaller(mcpGate('oauth')), writeRows: 1 },
  { name: 'MCP peer', caller: () => mcpToolCaller(mcpGate('peer')), writeRows: 1 },
  { name: 'MCP stdio', caller: () => mcpToolCaller(mcpGate('stdio')), writeRows: 1 },
  // Its route writes the row (auditMcpKeyCall), before the call.
  { name: 'MCP key', caller: () => mcpToolCaller(mcpGate('key')), writeRows: 0 },
];

async function call(
  entry: (typeof ENTRIES)[number],
  tool: Tool,
): Promise<{ ok: boolean; rows: CallAuditRow[] }> {
  rows.length = 0;
  const slug = tool.slug;
  const res = await dispatchTool(
    tool,
    {},
    {
      ownerId: LOGIN,
      ...(entry.surface ? { surface: entry.surface } : {}),
      caller: entry.caller(slug),
    },
  );
  return { ok: res.ok, rows: [...rows] };
}

describe('one audit row for every tool write, on every surface (A5 step 6d)', () => {
  it('the table: a read leaves none, a write one, on every entry', async () => {
    const table: Record<string, { read: number; write: number }> = {};
    for (const entry of ENTRIES) {
      const read = await call(entry, row('audit_probe_read'));
      const write = await call(entry, row('audit_probe_write'));
      expect(read.ok && write.ok, entry.name).toBe(true);
      table[entry.name] = { read: read.rows.length, write: write.rows.length };
    }
    expect(table).toEqual(
      Object.fromEntries(ENTRIES.map((e) => [e.name, { read: 0, write: e.writeRows }])),
    );
  });

  it('a row names the tool, the entry, how it came in and what it made', async () => {
    const turn = await call(ENTRIES[0]!, row('audit_probe_write'));
    expect(turn.rows).toEqual([
      {
        loginId: null,
        // The actor the test binds (none names a login here).
        actorLabel: expect.stringMatching(/ \(turn\)$/),
        method: 'TOOL',
        path: null,
        meta: null,
        detail: {
          tool: 'audit_probe_write',
          entry: 'turn',
          via: 'turn',
          surface: 'web',
          targets: [MADE],
        },
      },
    ]);
    const oauth = await call(
      ENTRIES.find((e) => e.name === 'MCP OAuth login')!,
      row('audit_probe_write'),
    );
    expect(oauth.rows).toEqual([
      {
        loginId: LOGIN,
        actorLabel: 'login (mcp)',
        method: 'MCP',
        path: '/api/mcp',
        meta: null,
        detail: {
          tool: 'audit_probe_write',
          entry: 'mcp',
          via: 'oauth',
          targets: [MADE],
          oauthClientId: 'c1',
        },
      },
    ]);
  });

  it('a failed write leaves none', async () => {
    for (const entry of ENTRIES) {
      const res = await call(entry, row('audit_probe_fail'));
      expect(res.ok, entry.name).toBe(false);
      expect(res.rows, entry.name).toEqual([]);
    }
  });

  it("a recipe's step is named in the recipe's row; a recipe of reads leaves none", async () => {
    const recipe = (step: string) =>
      row('audit_recipe', { kind: 'recipe', steps: [{ tool: step, input: {} }] });
    const turn = ENTRIES[0]!;
    const writes = await call(turn, recipe('audit_probe_write'));
    expect(writes.ok).toBe(true);
    expect(writes.rows.map((r) => r.detail)).toEqual([
      expect.objectContaining({
        tool: 'audit_recipe',
        row: 'recipe',
        nested: ['audit_probe_write'],
      }),
    ]);
    const reads = await call(turn, recipe('audit_probe_read'));
    expect(reads.ok).toBe(true);
    expect(reads.rows).toEqual([]);
  });

  it('a write run inside another write is named in its row, never a row of its own', async () => {
    for (const entry of ENTRIES.filter((e) => e.writeRows === 1)) {
      const res = await call(entry, row('audit_probe_outer'));
      expect(res.ok, entry.name).toBe(true);
      expect(
        res.rows.map((r) => [r.detail.tool, r.detail.nested]),
        entry.name,
      ).toEqual([['audit_probe_outer', ['audit_probe_write']]]);
    }
  });

  it('writes nothing until the process starts the audit', async () => {
    stopCallAudit();
    try {
      const res = await call(ENTRIES[0]!, row('audit_probe_write'));
      expect(res.ok).toBe(true);
      expect(res.rows).toEqual([]);
    } finally {
      startCallAudit({ sink: (r) => rows.push(r) });
    }
  });
});
