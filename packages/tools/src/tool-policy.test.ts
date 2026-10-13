/**
 * The tool policy table and its views (A5 step 1, tool-policy.ts): a view
 * is read live from the table (a builtin registered later is in it), it
 * refuses every change, it throws before the registry has loaded (never an
 * answer from an empty table), and dispatch refuses a builtin row named with
 * another builtin's slug. What each view holds is pinned elsewhere
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
import { ADMIN_ONLY_TOOL_SLUGS, TOOL_ADMIN_AREAS } from './admin-gate';
import { dispatchTool } from './dispatch';
import { MEMBER_APP_REFUSED_SLUGS } from './member-app-tools';
import { getBuiltin, registerBuiltin } from './registry';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

describe('the policy views', () => {
  it('follow the table: a builtin registered later is in them', () => {
    expect(ADMIN_ONLY_TOOL_SLUGS.has('a5_probe_admin')).toBe(false);
    registerBuiltin({
      slug: 'a5_probe_admin',
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: {} },
      policy: { effect: 'read', spends: 'none', scope: { area: 'settings', adminOnly: true } },
      handler: async () => ({ ok: true, output: null }),
    });
    expect(ADMIN_ONLY_TOOL_SLUGS.has('a5_probe_admin')).toBe(true);
    expect(TOOL_ADMIN_AREAS.get('a5_probe_admin')).toBe('settings');
    expect([...ADMIN_ONLY_TOOL_SLUGS]).toContain('a5_probe_admin');
    // Its flags read the policy.
    expect(getBuiltin('a5_probe_admin')?.readOnly).toBe(true);
    expect(getBuiltin('a5_probe_admin')?.spends).toBeUndefined();
  });

  it('refuse every change', () => {
    const set = ADMIN_ONLY_TOOL_SLUGS as Set<string>;
    expect(() => set.add('x')).toThrow(/read only/);
    expect(() => set.delete('replay_window')).toThrow(/read only/);
    expect(() => set.clear()).toThrow(/read only/);
    const map = TOOL_ADMIN_AREAS as Map<string, string>;
    expect(() => map.set('x', 'keys')).toThrow(/read only/);
    expect(() => map.delete('model_catalog')).toThrow(/read only/);
    const list = MEMBER_APP_REFUSED_SLUGS as string[];
    expect(() => list.push('x')).toThrow(/read only|trap returned falsish/);
    expect(() => {
      list[0] = 'x';
    }).toThrow();
    expect(ADMIN_ONLY_TOOL_SLUGS.has('replay_window')).toBe(true);
    expect(MEMBER_APP_REFUSED_SLUGS).toContain('read_result');
    expect(Array.isArray(MEMBER_APP_REFUSED_SLUGS)).toBe(true);
  });

  it('throw before the registry has loaded (fail closed)', async () => {
    vi.resetModules();
    const fresh = await import('./tool-policy');
    const view = fresh.policySlugSet((p) => p.effect === 'read');
    expect(() => view.has('search_nodes')).toThrow(fresh.PolicyTableNotLoadedError);
    expect(() => fresh.builtinPolicy('search_nodes')).toThrow(fresh.PolicyTableNotLoadedError);
  });
});

describe("a builtin row named with another builtin's slug", () => {
  const CTX = { ownerId: 'o1', surface: { kind: 'owner', via: 'mcp' } } as ToolHandlerContext;
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
