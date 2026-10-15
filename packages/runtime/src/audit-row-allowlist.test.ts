/**
 * Which tools write without the gate's audit row (A5 step 6c, closing 6d's
 * L5): a write whose policy says it is routine internal state
 * (`ToolPolicy.auditRow`, read off the policy by call-audit.ts, never a
 * list) leaves no `api.write` row. The flag hides a write from the audit
 * trail, so the set that carries it, and how, is pinned here: only
 * heartbeat_update_state (a heartbeat's own scratch state, once per fire),
 * and only when it names no `slug` (lows round, 6d L5): a call naming a
 * heartbeat, as a responder turn must, may move another login's heartbeat
 * to its own, so it keeps its row. A new tool that takes the flag fails
 * this test until it is named here, with its reason, in review.
 *
 * In @mantle/runtime: the lowest package that sees every builtin (the
 * heartbeat tools register at boot) and the MCP surface's own definitions.
 */
import { describe, expect, it } from 'vitest';
import { MCP_SURFACE_POLICIES, listBuiltins, type ToolPolicy } from '@mantle/tools';
import { registerHeartbeatTools } from './heartbeats/tools';

/** The tools that may skip the audit row, how, and why. */
const NO_AUDIT_ROW: Readonly<Record<string, { flag: ToolPolicy['auditRow']; why: string }>> = {
  heartbeat_update_state: {
    flag: { unlessArg: 'slug' },
    why: "a heartbeat's own scratch state, written once per fire on the firing heartbeat",
  },
};

describe('the tools whose writes leave no audit row (auditRow)', () => {
  it('are exactly the named ones, each with its named flag', () => {
    registerHeartbeatTools();
    const flagged: Record<string, ToolPolicy['auditRow']> = {};
    for (const d of listBuiltins()) {
      if (d.policy.auditRow !== undefined) flagged[d.slug] = d.policy.auditRow;
    }
    for (const [slug, p] of Object.entries(MCP_SURFACE_POLICIES)) {
      const flag = (p as ToolPolicy).auditRow;
      if (flag !== undefined) flagged[slug] = flag;
    }
    expect(flagged).toEqual(
      Object.fromEntries(Object.entries(NO_AUDIT_ROW).map(([slug, v]) => [slug, v.flag])),
    );
  });

  it('each one is a write (a read leaves no row anyway, so the flag would say nothing)', () => {
    registerHeartbeatTools();
    for (const slug of Object.keys(NO_AUDIT_ROW)) {
      const def = listBuiltins().find((d) => d.slug === slug);
      expect(def?.policy.effect, slug).toBe('write');
    }
  });

  it("heartbeat_update_state's `slug` is a property of its input, so the flag reads a real argument", () => {
    registerHeartbeatTools();
    const def = listBuiltins().find((d) => d.slug === 'heartbeat_update_state');
    const props = (def?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).toContain('slug');
  });
});
