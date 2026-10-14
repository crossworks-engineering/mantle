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
  type ToolPolicy,
} from '@mantle/tools';
import { registerHeartbeatTools } from '@mantle/runtime';
import { mcpToolPolicy } from './gate-policy';
import { MCP_TOOL_DEFS } from './mcp-defs';
import { AREA_PREFIXES, familyKeyArea } from './key-scope';
import { registerMantleTools } from './build-server';
import { PEER_RISKY_TOOL_PREFIXES } from './login-surface';
import {
  ADMIN_KIND_CREATE_TOOL_SLUGS,
  isMcpToolReadOnly,
  isPeerRiskyTool,
  KEY_SHARED_CONTENT_TOOLS,
  LIST_TOOLS,
  ownerPeerAllows,
  PEER_RISKY_TOOL_SLUGS,
  spendsOwnerKeys,
} from './policy-views.test-helper';

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

  // Renamed in step 2 fix round 1 (LOW-3): since step 2 the gate's
  // `mcp-tool` source IS toGatePolicy of the declared policy, so this no
  // longer compares two policies, only the wiring: every builtin has an
  // entry, read from its own policy (a twin's from its definition, the
  // same). The values from before step 2 are pinned by the step 2 snapshot
  // (surface-decisions.json, tools-list.matrix.json).
  it("the gate's mcp-tool source reads each builtin's and definition's declared policy", () => {
    const drift: string[] = [];
    for (const { slug, policy } of [...DEFS, ...MCP_TOOL_DEFS]) {
      const read = mcpToolPolicy({ kind: 'mcp-tool', name: slug });
      expect(read, slug).not.toBeNull();
      if (JSON.stringify(gateView(read!)) !== JSON.stringify(gateView(toGatePolicy(policy)))) {
        drift.push(slug);
      }
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
    // A5 step 5 (owner decision Q1 b): a connector tool an Admin marked
    // read-only is a read for a read-only key or peer too, where the
    // listing's by-name rule counted every connector tool a write. The
    // only cells that differ from ownerPeerAllows.
    const markedRead = new Set([connectors[1]!.slug]);
    let changed = 0;
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
            const before = ownerPeerAllows(c.name, { write, riskyAllowed });
            const now = before || (!write && markedRead.has(c.name));
            expect(refused === null, label).toBe(now);
            if (now !== before) changed += 1;
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
    // key and peer, Write off, each risky set: the marked connector only.
    expect(changed).toBe(2 * riskySets.length);
  });

  it('a stale read-only mark stays hidden from a read-only key or peer (A5 step 5, Q1)', () => {
    const marked = connector('contacts_list', true);
    // The tool changed after the mark: its signature no longer matches.
    const stale = { ...marked, description: 'The crm contacts_list, changed.' } as Tool;
    expect(connectorToolPolicy(stale).fields.mark).toBe('stale');
    for (const via of ['key', 'peer'] as const) {
      const caller: GateCaller = {
        actor: loginActor('00000000-0000-4000-8000-0000000000aa', 'ro'),
        via,
        write: false,
        admin: null,
        facts: { keyAreas: null, riskyAllowed: [] },
      };
      const ref = (row: Tool) => ({ kind: 'runtime-tool', name: row.slug, row }) as never;
      const policy = (row: Tool) => connectorToolPolicy(row) as GatePolicy;
      expect(GATE_NARROWERS.peer(caller, policy(marked), ref(marked)), via).toBeNull();
      expect(GATE_NARROWERS.peer(caller, policy(stale), ref(stale)), via).not.toBeNull();
    }
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

/**
 * The family safety net (step 2 fix round 1, MEDIUM-1). Before step 2 a
 * tool was risky for a key or a peer by its family whatever it declared (a
 * new web_*, telegram_*, sandbox_* or peer_* builtin, an app_* write, one
 * that starts model work or waits for the owner's confirm), and a *_from_*
 * tool had no key area whatever it declared (M2 audit F2). Since step 2 the
 * policy decides, so a tool that forgets `peerRisky` would be open to keys
 * and peers with Write on. This sweep holds every builtin and every
 * hand-written MCP definition to its family: the families are the kept
 * PEER_RISKY_TOOL_PREFIXES and AREA_PREFIXES (owner decision: kept until
 * A5 step 4), read here, not copied.
 */
describe('every declared tool keeps its family (step 2 fix round 1, MEDIUM-1)', () => {
  type Declared = {
    slug: string;
    policy: ToolPolicy;
    requiresConfirm?: boolean;
    optIn?: string;
  };

  /** Why `t` is risky by the rules isPeerRiskyTool had before step 2
   *  (login-surface.ts at v0.300.27), the name list aside; null if none. */
  function familyRisk(t: Declared): string | null {
    const prefix = PEER_RISKY_TOOL_PREFIXES.find((p) => t.slug.startsWith(p));
    if (prefix) return `family ${prefix}`;
    // A mini app's tool that writes (its data's tools are the app_data_ area,
    // held to the grant's Write): login-surface.ts familyPeerRisky.
    if (
      t.slug.startsWith('app_') &&
      !t.slug.startsWith('app_data_') &&
      t.policy.effect !== 'read'
    ) {
      return 'an app_ write';
    }
    if (t.policy.startsModelWork === true) return 'starts model work';
    if (t.requiresConfirm === true) return "waits for the owner's confirm";
    // A registration opt-in (the Toolsmith writes, the server shell) marks a
    // tool the box may hide from MCP: risky for a key or a peer too (A5 step
    // 3a, LOW-B).
    if (t.optIn !== undefined) return `opts in (${t.optIn})`;
    return null;
  }

  /** The area `t` must declare by its family (familyKeyArea reads
   *  AREA_PREFIXES and the _from_ rule): null for a conversion, the family's
   *  area otherwise; an app_data_ tool is its own area. Undefined: no
   *  family, any declared area. */
  function familyArea(t: Declared): string | null | undefined {
    if (t.slug.startsWith('app_data_')) return 'app_data';
    const area = familyKeyArea(t.slug);
    if (area !== null) return area;
    if (t.slug.includes('_from_')) return null;
    return undefined;
  }

  /** Every way `tools` leave their families. */
  function familyDrift(tools: readonly Declared[]): string[] {
    const out: string[] = [];
    for (const t of tools) {
      const risk = familyRisk(t);
      if (risk && t.policy.peerRisky !== true) out.push(`${t.slug}: ${risk}, not peerRisky`);
      const area = familyArea(t);
      const declared = t.policy.keyArea ?? null;
      if (area !== undefined && declared !== area) {
        out.push(`${t.slug}: key area ${String(declared)}, its family's is ${String(area)}`);
      }
    }
    return out;
  }

  const TOOLS: Declared[] = [...DEFS, ...MCP_TOOL_DEFS];

  it('reads the kept families', () => {
    expect([...PEER_RISKY_TOOL_PREFIXES].sort()).toEqual([
      'peer_',
      'sandbox_',
      'telegram_',
      'web_',
    ]);
    expect(AREA_PREFIXES.map(([p]) => p)).toContain('page_');
    expect(familyKeyArea('page_from_journal')).toBeNull();
    // Each family has declared tools here, so the sweep is not vacuous.
    for (const prefix of [...PEER_RISKY_TOOL_PREFIXES, ...AREA_PREFIXES.map(([p]) => p)]) {
      if (prefix === 'my_app_') continue; // a member's app tools: no builtin today
      expect(
        TOOLS.some((t) => t.slug.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
    expect(TOOLS.filter((t) => t.slug.includes('_from_')).length).toBeGreaterThan(5);
  });

  it('every builtin and MCP definition of a risky family is peerRisky; every family tool has its area', () => {
    expect(TOOLS.length).toBeGreaterThan(290);
    expect(familyDrift(TOOLS)).toEqual([]);
  });

  it("fails when one tool's peerRisky flips, or a conversion declares an area", () => {
    const flip = (slug: string, change: (p: ToolPolicy) => ToolPolicy): Declared[] =>
      TOOLS.map((t) => (t.slug === slug ? { ...t, policy: change(t.policy) } : t));
    const withoutRisk = (p: ToolPolicy): ToolPolicy => {
      const { peerRisky: _gone, ...rest } = p;
      return rest;
    };
    for (const slug of ['web_fetch', 'telegram_send', 'app_publish', 'ask_responder']) {
      expect(
        TOOLS.some((t) => t.slug === slug),
        slug,
      ).toBe(true);
      expect(familyDrift(flip(slug, withoutRisk)), slug).toEqual([
        expect.stringMatching(new RegExp(`^${slug}: .*not peerRisky$`)),
      ]);
    }
    expect(familyDrift(flip('page_from_journal', (p) => ({ ...p, keyArea: 'pages' })))).toEqual([
      "page_from_journal: key area pages, its family's is null",
    ]);
    expect(familyDrift(flip('page_create', (p) => ({ ...p, keyArea: 'search' })))).toEqual([
      "page_create: key area search, its family's is pages",
    ]);
  });
});
