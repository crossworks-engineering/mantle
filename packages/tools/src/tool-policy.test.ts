/**
 * The tool policy table (A5 step 1, tool-policy.ts): it is read live (a
 * builtin registered later is read by every check), it keeps no list view
 * (A5 step 6a deleted them), it throws before the registry has loaded (never
 * an answer from an empty table), and dispatch refuses a builtin row named
 * with another builtin's slug. What each former list holds is pinned elsewhere
 * (packages/runtime/src/tool-policy-snapshot.test.ts; the sweep against the
 * gate in @mantle/mcp-core tool-policy-sweep.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';

// dispatch.ts imports @mantle/db at module scope; the refusal under test
// never reaches it (as dispatch.test.ts).
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
  tools: {},
}));

import type { Tool } from '@mantle/db';
import { dispatchTool } from './dispatch';
import { runCaller } from './gate-callers';
// The one gate's narrowers and pre-run checks (every call runs through it).
import './gate-narrowers';
import { memberAppRefusedName } from './member-app-tools';
import { builtinToolGatePolicy, builtinToolRef } from './tool-gate-policy';
import { builtinPolicy, namedToolPolicy, policyAdminOnly, policyArea } from './tool-policy';
import { getBuiltin, registerBuiltin } from './registry';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

describe('the policy table', () => {
  it('is read live: a builtin registered later is read by every check', () => {
    expect(namedToolPolicy('a5_probe_admin')).toBeNull();
    registerBuiltin({
      slug: 'a5_probe_admin',
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: {} },
      policy: { effect: 'read', spends: 'none', scope: { area: 'settings', adminOnly: true } },
      handler: async () => ({ ok: true, output: null }),
    });
    const policy = namedToolPolicy('a5_probe_admin')!.policy;
    expect(policyAdminOnly(policy)).toBe(true);
    expect(policyArea(policy)).toBe('settings');
    expect(
      builtinToolGatePolicy(builtinToolRef('a5_probe_admin', 'a5_probe_admin'))?.scope,
    ).toEqual({
      area: 'settings',
    });
    // Its flags read the policy.
    expect(getBuiltin('a5_probe_admin')?.readOnly).toBe(true);
    expect(getBuiltin('a5_probe_admin')?.spends).toBeUndefined();
    expect(policyAdminOnly(builtinPolicy('replay_window')!)).toBe(true);
    expect(memberAppRefusedName('read_result')).toBe(true);
  });

  it('keeps no list view (A5 step 6a): every check reads the policy', async () => {
    const mod = (await import('./tool-policy')) as Record<string, unknown>;
    for (const gone of ['policySlugSet', 'policySlugMap', 'policySlugList']) {
      expect(mod[gone], gone).toBeUndefined();
    }
  });

  it('throws before the registry has loaded (fail closed)', async () => {
    vi.resetModules();
    const fresh = await import('./tool-policy');
    expect(() => fresh.builtinPolicy('search_nodes')).toThrow(fresh.PolicyTableNotLoadedError);
    expect(() => fresh.namedToolPolicy('search_nodes')).toThrow(fresh.PolicyTableNotLoadedError);
  });
});

describe("a builtin row named with another builtin's slug", () => {
  const CTX = {
    ownerId: 'o1',
    surface: { kind: 'owner', via: 'mcp' },
    caller: runCaller(),
  } as ToolHandlerContext;
  const row = (slug: string, ref: string) =>
    ({ slug, handler: { kind: 'builtin', ref } }) as unknown as Tool;

  it('does not run', async () => {
    const res = await dispatchTool(row('page_create', 'calculate'), { expression: '1+1' }, CTX);
    expect(res).toEqual({
      ok: false,
      error: expect.stringMatching(/another built-in tool's name, but runs 'calculate'/),
    });
  });

  it('a row named by its ref, or by a name no builtin has, runs', async () => {
    const def = getBuiltin('calculate') as BuiltinToolDef;
    expect(def).toBeTruthy();
    for (const slug of ['calculate', 'my_calculator']) {
      const res = await dispatchTool(row(slug, 'calculate'), { expression: '1+1' }, CTX);
      expect(res.ok, slug).toBe(true);
    }
  });
});
