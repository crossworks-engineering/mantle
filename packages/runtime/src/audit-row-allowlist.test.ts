/**
 * Which tools write without the gate's audit row (A5 step 6c, closing 6d's
 * L5): a write whose policy says it is routine internal state
 * (`ToolPolicy.auditRow: false`, read off the policy by call-audit.ts,
 * never a list) leaves no `api.write` row. The flag hides a write from the
 * audit trail, so the set that carries it is pinned here: only
 * heartbeat_update_state (a heartbeat's own scratch state, once per fire).
 * A new tool that takes the flag fails this test until it is named here,
 * with its reason, in review.
 *
 * In @mantle/runtime: the lowest package that sees every builtin (the
 * heartbeat tools register at boot) and the MCP surface's own definitions.
 */
import { describe, expect, it } from 'vitest';
import { MCP_SURFACE_POLICIES, listBuiltins, type ToolPolicy } from '@mantle/tools';
import { registerHeartbeatTools } from './heartbeats/tools';

/** The tools that may skip the audit row, and why. */
const NO_AUDIT_ROW: Readonly<Record<string, string>> = {
  heartbeat_update_state: "a heartbeat's own scratch state, written once per fire",
};

describe('the tools whose writes leave no audit row (auditRow: false)', () => {
  it('are exactly the named ones', () => {
    registerHeartbeatTools();
    const builtins = listBuiltins()
      .filter((d) => d.policy.auditRow === false)
      .map((d) => d.slug);
    const surface = Object.entries(MCP_SURFACE_POLICIES)
      .filter(([, p]) => (p as ToolPolicy).auditRow === false)
      .map(([slug]) => slug);
    expect([...new Set([...builtins, ...surface])].sort()).toEqual(
      Object.keys(NO_AUDIT_ROW).sort(),
    );
  });

  it('each one is a write (a read leaves no row anyway, so the flag would say nothing)', () => {
    registerHeartbeatTools();
    for (const slug of Object.keys(NO_AUDIT_ROW)) {
      const def = listBuiltins().find((d) => d.slug === slug);
      expect(def?.policy.effect, slug).toBe('write');
    }
  });
});
