import { describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/runtime/assistant', () => ({
  runSimulatedResponderTurn: vi.fn(),
  describeResponderPersona: vi.fn(),
}));

import { BUILTIN_TOOLS, MCP_SURFACE_POLICIES } from '@mantle/tools';
import { registerMantleTools } from './build-server';
import { DESTRUCTIVE_WRITES, IDEMPOTENT_WRITES, type ToolHints } from './tool-annotations';

/**
 * The hints the real registration emits, for every tool of the owner MCP
 * surface (register/surface.test.ts pins the names; this pins the hints).
 *
 * The one rule that must hold: a tool says read-only exactly when its
 * declared policy says `read`. A client offers "Always allow" on a
 * read-only tool, so a write marked read-only would run without a prompt.
 */

type Registered = { name: string; hints: ToolHints | undefined };

/** Register onto a capturing fake; the SDK server is not needed here. */
function surface(transport: 'stdio' | 'http'): Registered[] {
  const out: Registered[] = [];
  const server = {
    registerTool: (name: string, config: { annotations?: ToolHints }) =>
      void out.push({ name, hints: config.annotations }),
  };
  registerMantleTools(server as never, 'owner-1', { transport });
  return out;
}

/** The declared effect of a registered name: a definition's policy, else
 *  the builtin's (the same precedence as mcp-policy.ts mcpToolPolicyOf). */
const EFFECT = new Map<string, 'read' | 'write'>();
for (const def of BUILTIN_TOOLS) EFFECT.set(def.slug, def.policy.effect);
for (const [slug, policy] of Object.entries(MCP_SURFACE_POLICIES)) EFFECT.set(slug, policy.effect);

describe('MCP tool hints on the surface', () => {
  const stdio = surface('stdio');

  it('every registered tool carries hints with its slug as the title', () => {
    for (const { name, hints } of stdio) {
      expect(hints, name).toBeDefined();
      expect(hints?.title, name).toBe(name);
    }
  });

  it('every effect:read tool says read-only and no effect:write tool does', () => {
    expect(stdio.length).toBeGreaterThan(200);
    for (const { name, hints } of stdio) {
      const effect = EFFECT.get(name);
      expect(effect, `${name} has a declared policy`).toBeDefined();
      expect(hints?.readOnlyHint, name).toBe(effect === 'read');
    }
  });

  it('a read is never destructive and always idempotent', () => {
    for (const { name, hints } of stdio) {
      if (EFFECT.get(name) !== 'read') continue;
      expect(hints?.destructiveHint, name).toBe(false);
      expect(hints?.idempotentHint, name).toBe(true);
    }
  });

  it('the name lists name registered writes only (a renamed tool fails here)', () => {
    const writes = new Set(stdio.filter((r) => EFFECT.get(r.name) === 'write').map((r) => r.name));
    for (const name of DESTRUCTIVE_WRITES)
      expect(writes.has(name), `destructive ${name}`).toBe(true);
    for (const name of IDEMPOTENT_WRITES) expect(writes.has(name), `idempotent ${name}`).toBe(true);
  });

  it('the same hints over http (minus run_terminal)', () => {
    const byName = new Map(stdio.map((r) => [r.name, r.hints]));
    for (const { name, hints } of surface('http')) expect(hints, name).toEqual(byName.get(name));
  });

  it('pins the open-world tools', () => {
    const open = stdio
      .filter((r) => r.hints?.openWorldHint)
      .map((r) => r.name)
      .sort();
    expect(open).toEqual([
      'email_page',
      'email_send',
      'peer_call',
      'peer_file_copy',
      'peer_list',
      'peer_node_get',
      'peer_query',
      'peer_search_chunks',
      'peer_tools',
      'telegram_send',
      'web_crawl',
      'web_fetch',
      'web_map',
      'web_search',
      'web_search_pro',
    ]);
  });

  it('pins the destructive tools', () => {
    const destructive = stdio
      .filter((r) => r.hints?.destructiveHint)
      .map((r) => r.name)
      .sort();
    expect(destructive).toEqual([...DESTRUCTIVE_WRITES].sort());
  });

  it('pins the idempotent writes', () => {
    const idem = stdio
      .filter((r) => EFFECT.get(r.name) === 'write' && r.hints?.idempotentHint)
      .map((r) => r.name)
      .sort();
    expect(idem).toEqual([...IDEMPOTENT_WRITES].sort());
  });
});
