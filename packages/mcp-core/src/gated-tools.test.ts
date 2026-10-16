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

import { z } from 'zod';
import type { CallInput, GateCaller, GatePolicy, PreRunCheck } from '@mantle/db';
import { registerGatedTool, type McpGate } from './gated-tools';
import { defaultMcpGate } from './gate-policy';
import { MCP_TOOL_DEFS } from './mcp-defs';

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
