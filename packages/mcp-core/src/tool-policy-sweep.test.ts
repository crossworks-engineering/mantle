/**
 * The A5 step 1 sweep (workspaces arch plan v2, section 23.3): every
 * builtin carries a policy, and for every builtin the gate's reading of it
 * (toGatePolicy) equals what the gate gets today (mcpToolPolicy, derived
 * from the lists until step 2 derives them from the policy). Also pinned:
 * the parts of the policy the owner MCP surface's own lists still decide
 * (the key's shared content and the Admin-only kinds), so step 2 can swap
 * the lists for the policy with nothing to find.
 *
 * Here and not in @mantle/tools: this package sees every builtin (the
 * heartbeat tools of @mantle/runtime too) and the gate policy of today.
 */
import { describe, expect, it } from 'vitest';
import type { GatePolicy } from '@mantle/db';
import {
  builtinRowSlugError,
  isBuiltinReadOnly,
  isBuiltinSpending,
  listBuiltins,
  toGatePolicy,
  type BuiltinToolDef,
} from '@mantle/tools';
import { registerHeartbeatTools } from '@mantle/runtime';
import { ADMIN_KIND_CREATE_TOOL_SLUGS } from './create-home';
import { mcpToolPolicy } from './gate-policy';
import { KEY_SHARED_CONTENT_TOOLS } from './key-scope';
import { isMcpToolReadOnly, isPeerRiskyTool, spendsOwnerKeys } from './login-surface';

registerHeartbeatTools();
const DEFS: BuiltinToolDef[] = listBuiltins();

/** What the gate reads of a policy: the step order's fields and the
 *  narrowers' two (a key's area, a peer's risky mark). `creates` as the gate
 *  reads it, by truth: today's policy says `true`, the declared one names
 *  the kind. */
function gateView(p: GatePolicy) {
  return {
    effect: p.effect,
    scope: p.scope,
    spends: p.spends,
    creates: Boolean(p.creates),
    makesItems: p.makesItems,
    actor: p.actor,
    keyArea: p.fields?.keyArea ?? null,
    peerRisky: p.fields?.peerRisky === true,
  };
}

describe('a policy on every builtin (A5 step 1)', () => {
  it('sees every builtin, the heartbeat tools too', () => {
    expect(DEFS.length).toBeGreaterThan(280);
    expect(DEFS.map((d) => d.slug)).toContain('heartbeat_fire');
  });

  it('every builtin has a policy of the declared shape', () => {
    for (const d of DEFS) {
      const p = d.policy;
      expect(p, d.slug).toBeTruthy();
      expect(['read', 'write'], d.slug).toContain(p.effect);
      expect(['none', 'model', 'ownerKey'], d.slug).toContain(p.spends);
      expect(
        typeof p.scope === 'object' || ['any', 'admin', 'admin-kind'].includes(p.scope),
        d.slug,
      ).toBe(true);
      // Model work always spends; a create always writes.
      if (p.startsModelWork) expect(p.spends, d.slug).not.toBe('none');
      if (p.creates) expect(p.effect, d.slug).toBe('write');
      // No builtin says makesItems yet: the gate gets none today.
      expect(p.makesItems, d.slug).toBeUndefined();
    }
  });

  it("toGatePolicy equals today's gate policy, for every builtin", () => {
    const drift: string[] = [];
    for (const d of DEFS) {
      const today = mcpToolPolicy({ kind: 'mcp-tool', name: d.slug });
      expect(today, d.slug).not.toBeNull();
      const declared = gateView(toGatePolicy(d.policy));
      if (JSON.stringify(declared) !== JSON.stringify(gateView(today!))) drift.push(d.slug);
      expect(declared, d.slug).toEqual(gateView(today!));
    }
    expect(drift).toEqual([]);
  });

  it("the flags are the policy's: readOnly, spends and the registry's answers", () => {
    for (const d of DEFS) {
      for (const flag of ['readOnly', 'spends'] as const) {
        expect(typeof Object.getOwnPropertyDescriptor(d, flag)?.get, `${d.slug} ${flag}`).toBe(
          'function',
        );
      }
      expect(d.readOnly === true, d.slug).toBe(d.policy.effect === 'read');
      expect(d.spends === true, d.slug).toBe(d.policy.startsModelWork === true);
      expect(isBuiltinReadOnly(d.slug), d.slug).toBe(d.policy.effect === 'read');
      expect(isBuiltinSpending(d.slug), d.slug).toBe(d.policy.startsModelWork === true);
    }
  });

  it("the owner MCP surface's lists agree with the policy (step 2 derives them)", () => {
    for (const d of DEFS) {
      const p = d.policy;
      expect(isMcpToolReadOnly(d.slug), d.slug).toBe(p.effect === 'read');
      expect(spendsOwnerKeys(d.slug), d.slug).toBe(p.spends === 'ownerKey');
      expect(isPeerRiskyTool(d.slug), d.slug).toBe(p.peerRisky === true);
      expect(KEY_SHARED_CONTENT_TOOLS.has(d.slug), d.slug).toBe(p.keySharedContent === true);
      expect(ADMIN_KIND_CREATE_TOOL_SLUGS.has(d.slug), d.slug).toBe(p.scope === 'admin-kind');
    }
  });

  it("refuses a builtin row named with another builtin's slug", () => {
    expect(builtinRowSlugError('search_nodes', 'search_nodes')).toBeNull();
    expect(builtinRowSlugError('my_search', 'search_nodes')).toBeNull();
    expect(builtinRowSlugError('page_create', 'search_nodes')).toMatch(
      /named 'page_create', another built-in tool's name, but runs 'search_nodes'/,
    );
  });
});
