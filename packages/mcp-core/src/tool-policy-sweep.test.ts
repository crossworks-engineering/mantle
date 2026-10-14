/**
 * The A5 step 1 sweep (workspaces arch plan v2, section 23.3): every
 * builtin carries a policy, and for every builtin the gate's reading of it
 * (toGatePolicy) equals what the gate gets (mcpToolPolicy: since step 2 the
 * declared policy itself, so the two agree by construction; the step-2
 * snapshot, surface-decisions.json, pins the values from before). Also
 * pinned: the owner MCP surface's lists agree with the policy (since step 2
 * they are views of it), and (step 2) the gate's peer narrower, reading the
 * declared mark, equals the listing's rule (ownerPeerAllows) for every tool
 * the surface registers and every key and peer caller.
 *
 * Here and not in @mantle/tools: this package sees every builtin (the
 * heartbeat tools of @mantle/runtime too) and the gate policy of today.
 */
import { describe, expect, it } from 'vitest';
import {
  loginActor,
  type GateCaller,
  type GatePolicy,
  type Tool,
  type ToolHandler,
} from '@mantle/db';
import {
  GATE_NARROWERS,
  RISKY_TOOL_ERROR,
  builtinRowSlugError,
  connectorToolPolicy,
  externalAccessToolSig,
  isBuiltinReadOnly,
  isBuiltinSpending,
  listBuiltins,
  toGatePolicy,
  type BuiltinToolDef,
} from '@mantle/tools';
import { registerHeartbeatTools } from '@mantle/runtime';
import { ADMIN_KIND_CREATE_TOOL_SLUGS } from './create-home';
import { mcpToolPolicy } from './gate-policy';
import { LIST_TOOLS } from './key-email-guard';
import { KEY_SHARED_CONTENT_TOOLS } from './mcp-policy';
import { registerMantleTools } from './build-server';
import {
  PEER_RISKY_TOOL_SLUGS,
  isMcpToolReadOnly,
  isPeerRiskyTool,
  ownerPeerAllows,
  spendsOwnerKeys,
} from './login-surface';

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
      expect(LIST_TOOLS.has(d.slug), d.slug).toBe(p.keyEmail === true);
      expect(ADMIN_KIND_CREATE_TOOL_SLUGS.has(d.slug), d.slug).toBe(p.scope === 'admin-kind');
    }
    // Every name LIST_TOOLS holds is a builtin's: the two say the same set.
    expect([...LIST_TOOLS].sort()).toEqual(
      DEFS.filter((d) => d.policy.keyEmail === true)
        .map((d) => d.slug)
        .sort(),
    );
  });

  it("refuses a builtin row named with another builtin's slug", () => {
    expect(builtinRowSlugError('search_nodes', 'search_nodes')).toBeNull();
    expect(builtinRowSlugError('my_search', 'search_nodes')).toBeNull();
    expect(builtinRowSlugError('page_create', 'search_nodes')).toMatch(
      /named 'page_create', another built-in tool's name, but runs 'search_nodes'/,
    );
  });
});

describe("the gate's peer narrower reads the declared mark (A5 step 2)", () => {
  /** Every name the owner surface registers (a capturing fake server). */
  function registered(): string[] {
    const out: string[] = [];
    const capture = { registerTool: (name: string) => void out.push(name) };
    registerMantleTools(capture as never, 'owner-1', { transport: 'stdio' });
    return out;
  }
  /** A connector row, with the admin's read-only mark or without. */
  function connector(toolName: string, marked: boolean): Tool {
    const row = {
      slug: `mcp_crm_${toolName}`,
      description: `The crm ${toolName}.`,
      inputSchema: { type: 'object', properties: {} },
      handler: { kind: 'mcp', group: 'mcp-crm', toolName } satisfies ToolHandler,
      requiresConfirm: false,
      externalAccess: null,
    } as unknown as Tool;
    if (!marked) return row;
    return {
      ...row,
      externalAccess: {
        confirmedReadOnlyAt: new Date(0).toISOString(),
        by: { via: 'web' },
        handlerSig: externalAccessToolSig(row),
      },
    } as Tool;
  }

  it('equals ownerPeerAllows, for every tool and connector and every key and peer caller', () => {
    const names = registered();
    const connectors = [connector('contacts_update', false), connector('contacts_list', true)];
    const cases: { name: string; policy: GatePolicy; ref: Record<string, unknown> }[] = [
      ...names.map((name) => {
        const ref = { kind: 'mcp-tool', name };
        return { name, policy: mcpToolPolicy(ref)!, ref };
      }),
      ...connectors.map((row) => ({
        name: row.slug,
        policy: connectorToolPolicy(row) as GatePolicy,
        ref: { kind: 'runtime-tool', name: row.slug, row },
      })),
    ];
    const riskySets: (readonly string[])[] = [
      [],
      ['email_send', 'web_crawl', 'telegram_send'],
      [...PEER_RISKY_TOOL_SLUGS, ...connectors.map((c) => c.slug)],
    ];
    let cells = 0;
    for (const via of ['key', 'peer'] as const) {
      for (const write of [true, false]) {
        for (const riskyAllowed of riskySets) {
          const caller: GateCaller = {
            actor: loginActor('00000000-0000-4000-8000-0000000000aa', write ? 'rw' : 'ro'),
            via,
            write,
            admin: null,
            facts: { keyAreas: null, riskyAllowed },
          };
          for (const c of cases) {
            const refused = GATE_NARROWERS.peer(caller, c.policy, c.ref as never);
            const label = `${via}/${write}/${riskyAllowed.length} ${c.name}`;
            expect(refused === null, label).toBe(ownerPeerAllows(c.name, { write, riskyAllowed }));
            // The refusal names the reason the listing's rule has.
            if (refused !== null) {
              const risky = isPeerRiskyTool(c.name) && !riskyAllowed.includes(c.name);
              expect(refused === RISKY_TOOL_ERROR, label).toBe(risky);
            }
            cells += 1;
          }
        }
      }
    }
    expect(cells).toBeGreaterThan(3000);
  });

  it('a tool whose policy declares no peer mark is refused for a key or a peer, even named', () => {
    const policy: GatePolicy = { effect: 'read', scope: 'any', spends: 'none', fields: {} };
    const ref = { kind: 'mcp-tool', name: 'unmarked_tool' };
    for (const via of ['key', 'peer'] as const) {
      const caller: GateCaller = {
        actor: loginActor('00000000-0000-4000-8000-0000000000aa', 'rw'),
        via,
        write: true,
        admin: null,
        facts: { riskyAllowed: ['unmarked_tool'] },
      };
      expect(GATE_NARROWERS.peer(caller, policy, ref)).toBe(RISKY_TOOL_ERROR);
    }
    const oauth: GateCaller = {
      actor: loginActor('00000000-0000-4000-8000-0000000000aa', 'rw'),
      via: 'oauth',
      write: true,
      admin: null,
    };
    expect(GATE_NARROWERS.peer(oauth, policy, ref)).toBeNull();
  });
});
