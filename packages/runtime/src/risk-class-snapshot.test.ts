/**
 * Every tool's risk class (@mantle/tools policyRiskClass), pinned. The MCP
 * map's call tools are split by it (tool_read, tool_write, tool_delete,
 * tool_send), so a tool that changes class changes which call tool a client
 * must use: the snapshot makes that a reviewed change. A new tool fails
 * here until its class is added to the snapshot.
 *
 * Beside the pin, the signals the derivation can miss: a name that says it
 * removes, a write that reaches out, a confirm-gated tool. Each one is in
 * the class it says, or set by its own `riskClass`.
 *
 * In @mantle/runtime: the heartbeat tools are builtins too, registered at
 * boot. No database.
 */
import { describe, expect, it } from 'vitest';

import {
  MCP_SURFACE_POLICIES,
  listBuiltins,
  policyRiskClass,
  type RiskClass,
  type ToolPolicy,
} from '@mantle/tools';
import { registerHeartbeatTools } from './heartbeats/tools';
import SNAPSHOT from './risk-class-snapshot.json' with { type: 'json' };

registerHeartbeatTools();

/** Every tool of the registry and the MCP surface, with its policy. */
function everyTool(): Array<{ slug: string; policy: ToolPolicy; confirm: boolean }> {
  const out = listBuiltins().map((d) => ({
    slug: d.slug,
    policy: d.policy,
    confirm: d.requiresConfirm === true,
  }));
  const seen = new Set(out.map((t) => t.slug));
  for (const [slug, policy] of Object.entries(MCP_SURFACE_POLICIES as Record<string, ToolPolicy>)) {
    if (!seen.has(slug)) out.push({ slug, policy, confirm: false });
  }
  return out;
}

describe('risk classes', () => {
  it('every tool is in the class the snapshot pins', () => {
    const now = Object.fromEntries(
      everyTool()
        .map((t) => [t.slug, policyRiskClass(t.policy)] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    expect(now).toEqual(SNAPSHOT);
  });

  it('a tool whose name says it removes is a delete', () => {
    const wrong = everyTool()
      .filter((t) => /_(delete|remove|rm)$/.test(t.slug) && policyRiskClass(t.policy) !== 'delete')
      .map((t) => t.slug);
    expect(wrong).toEqual([]);
  });

  it('a write that sends, publishes or is marked egress is a send', () => {
    const wrong = everyTool()
      .filter((t) => {
        const o = t.policy.outside;
        const sends = o?.egress || o?.via === 'send' || o?.via === 'publish';
        return t.policy.effect === 'write' && sends && policyRiskClass(t.policy) !== 'send';
      })
      .map((t) => t.slug);
    expect(wrong).toEqual([]);
  });

  it('a confirm-gated tool is never a read', () => {
    const wrong = everyTool()
      .filter((t) => t.confirm && policyRiskClass(t.policy) === 'read')
      .map((t) => t.slug);
    expect(wrong).toEqual([]);
  });

  it('a tool sets its own riskClass only where it differs from the derived one', () => {
    // A `riskClass` equal to what the other fields derive is noise: it
    // would hide a later change of those fields.
    const redundant = everyTool()
      .filter((t) => {
        const own = t.policy.riskClass;
        if (!own) return false;
        const derived = policyRiskClass({ ...t.policy, riskClass: undefined } as ToolPolicy);
        return own === derived;
      })
      .map((t) => t.slug);
    expect(redundant).toEqual([]);
  });

  it('a write set to read creates, destroys and deletes nothing', () => {
    // A read call tool may be auto-approved: a write a policy calls a read
    // must not make an item, destroy stored data or remove one.
    const wrong = everyTool()
      .filter((t) => t.policy.effect === 'write' && t.policy.riskClass === 'read')
      .filter((t) => t.policy.creates || t.policy.destructive || t.policy.deletesItem)
      .map((t) => t.slug);
    expect(wrong).toEqual([]);
  });

  it('the snapshot holds only the four classes', () => {
    const classes = new Set<RiskClass>(['read', 'write', 'delete', 'send']);
    expect(Object.values(SNAPSHOT).filter((c) => !classes.has(c as RiskClass))).toEqual([]);
  });
});
