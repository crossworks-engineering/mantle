/**
 * Dispatch for the owner MCP surface (workspaces arch A5 step 4): a call
 * that names an MCP caller (mcpToolCaller) runs through the one gate as
 * the connection's whole caller, by the `mcp-tool` ref it is listed under
 * (listing equals calling), and the MCP-only steps run for it:
 *
 *  - the gate binds the connection's caller, not one built from the state
 *    around (gateCallerFor);
 *  - a create's workspace argument reaches step 6 (the call's `ask`);
 *  - a key or a peer never confirms for the owner (`confirm` stripped);
 *  - an error the handler throws goes on to the surface (which answers it
 *    as it always has), where a turn reads it as the call's error text;
 *  - a call nested in it reuses the caller less the call's own parts (its
 *    ask, its pre-run check, the refusal of its creates);
 *  - the one masking of a database error's text.
 *
 * The database is stubbed: the create home's intent is the gate's own.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  currentCaller,
  currentCreateHome,
  hasPolicySource,
  loginActor,
  registerPolicySource,
  type GateCaller,
  type Tool,
} from '@mantle/db';
import { DATABASE_ERROR_PUBLIC } from '@mantle/std';
import { dispatchTool } from './dispatch';
import { mcpToolCaller, nestedToolCaller, turnCaller, type ToolCaller } from './gate-callers';
import { registerBuiltin } from './registry';
import { ensureGateReady } from './gate-narrowers';
import { builtinPolicy, toGatePolicy } from './tool-policy';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const LOGIN = '00000000-0000-4000-8000-0000000000b1';
const PRIVATE = '10000000-0000-4000-8000-000000000003';

const seen: {
  caller: GateCaller | null;
  home: unknown;
  ctx: ToolHandlerContext;
  input: unknown;
}[] = [];

function probe(slug: string, policy: BuiltinToolDef['policy'], throws?: Error): BuiltinToolDef {
  return {
    slug,
    name: slug,
    description: 'probe',
    inputSchema: { type: 'object', properties: {} },
    policy,
    handler: async (input, ctx) => {
      seen.push({ caller: currentCaller(), home: currentCreateHome(), ctx, input });
      if (throws) throw throws;
      return { ok: true, output: { ran: slug } };
    },
  };
}

const row = (slug: string) =>
  ({ slug, handler: { kind: 'builtin', ref: slug } }) as unknown as Tool;

/** A prepared connection's caller: a member outside Admin with a private
 *  workspace (every call under it), entering no scope of its own here. */
function connection(over: Partial<GateCaller> = {}): GateCaller {
  return Object.freeze({
    actor: loginActor(LOGIN, 'rw'),
    via: 'oauth',
    loginId: LOGIN,
    write: true,
    admin: { holdsAdmin: false, areas: new Set<string>() },
    enterScope: async <T>(_w: boolean, fn: () => Promise<T>) => fn(),
    createFallback: { privateWs: PRIVATE },
    createHome: { ownWork: true, first: true, namedOnly: true, reads: true },
    facts: { keyAreas: null, riskyAllowed: [] },
    ...over,
  });
}

beforeAll(() => {
  ensureGateReady();
  registerBuiltin(probe('mcp_probe_read', { effect: 'read', spends: 'none', scope: 'any' }));
  registerBuiltin(
    probe('mcp_probe_create', {
      effect: 'write',
      spends: 'none',
      scope: 'any',
      creates: 'page',
    }),
  );
  registerBuiltin(
    probe(
      'mcp_probe_throws',
      { effect: 'write', spends: 'none', scope: 'any' },
      new Error('boom, not a database error'),
    ),
  );
  registerBuiltin(
    probe(
      'mcp_probe_db',
      { effect: 'write', spends: 'none', scope: 'any' },
      Object.assign(new Error('Failed query: select secret from nodes'), {
        cause: Object.assign(new Error('duplicate key'), { code: '23505', severity: 'ERROR' }),
      }),
    ),
  );
  // The owner MCP surface's policy source (@mantle/mcp-core gate-policy.ts
  // registers it in a process that loads the surface): a builtin's own.
  if (!hasPolicySource('mcp-tool')) {
    registerPolicySource('mcp-tool', (ref) => {
      const p = builtinPolicy(ref.name);
      return p ? toGatePolicy(p) : null;
    });
  }
});
afterAll(() => {
  seen.length = 0;
});

describe('an MCP call through dispatch (A5 step 4)', () => {
  it('runs as the connection’s caller, by the mcp-tool ref it is listed under', async () => {
    seen.length = 0;
    const gate = connection();
    const res = await dispatchTool(
      row('mcp_probe_read'),
      {},
      {
        ownerId: 'o',
        caller: mcpToolCaller(gate),
      },
    );
    expect(res).toEqual({ ok: true, output: { ran: 'mcp_probe_read' } });
    const bound = seen[0]!.caller!;
    expect(bound.via).toBe('oauth');
    expect(bound.loginId).toBe(LOGIN);
    expect(bound.createFallback).toEqual({ privateWs: PRIVATE });
    // Every call of a login outside Admin runs under its private workspace.
    expect(seen[0]!.home).toEqual({ createWs: null, privateWs: PRIVATE });
  });

  it("a create's workspace argument reaches step 6; a nested call asks none", async () => {
    seen.length = 0;
    const caller = mcpToolCaller(connection(), { from: 'argument', workspace: undefined });
    expect(caller.ask).toEqual({ from: 'argument', workspace: undefined });
    await dispatchTool(row('mcp_probe_create'), {}, { ownerId: 'o', caller });
    expect(seen[0]!.home).toEqual({ createWs: null, privateWs: PRIVATE });
    const nested = seen[0]!.ctx.caller as ToolCaller;
    expect(nested.entry).toBe('mcp');
    expect(nested.ask).toBeNull();
  });

  it('a nested call keeps the connection, less the call’s own parts', () => {
    const preRun = async () => null;
    const gate = connection({
      preRun,
      createHome: { ownWork: false, first: true, namedOnly: true, refuseCreates: 'no home' },
    });
    const nested = nestedToolCaller(mcpToolCaller(gate, { from: 'argument', workspace: 'X' }));
    expect(nested.ask).toBeNull();
    expect(nested.gate?.preRun).toBeUndefined();
    expect(nested.gate?.createHome?.refuseCreates).toBeUndefined();
    expect(nested.gate?.createHome?.first).toBe(true);
    expect(nested.gate?.loginId).toBe(LOGIN);
    // Any other entry's caller is reused as it is.
    expect(nestedToolCaller(turnCaller())).toBe(turnCaller());
  });

  it('a key or a peer never confirms for the owner; an OAuth login does', async () => {
    for (const [via, kept] of [
      ['key', false],
      ['peer', false],
      ['oauth', true],
    ] as const) {
      seen.length = 0;
      await dispatchTool(
        row('mcp_probe_create'),
        { confirm: true },
        {
          ownerId: 'o',
          caller: mcpToolCaller(connection({ via })),
        },
      );
      expect('confirm' in (seen[0]!.input as object), via).toBe(kept);
    }
  });

  it('a thrown error goes on to the surface, which answers it as it always has', async () => {
    await expect(
      dispatchTool(
        row('mcp_probe_throws'),
        {},
        {
          ownerId: 'o',
          caller: mcpToolCaller(connection()),
        },
      ),
    ).rejects.toThrow('boom, not a database error');
  });

  it('a database error the handler throws is thrown on too (the surface masks it)', async () => {
    await expect(
      dispatchTool(row('mcp_probe_db'), {}, { ownerId: 'o', caller: mcpToolCaller(connection()) }),
    ).rejects.toThrow();
    expect(DATABASE_ERROR_PUBLIC).toMatch(/server log/);
  });

  it('only an MCP via names an MCP caller', () => {
    expect(() => mcpToolCaller(connection({ via: 'turn' }))).toThrow(/not an MCP via/);
    expect(mcpToolCaller(connection({ via: 'stdio' })).via).toBe('stdio');
  });
});
