/**
 * The owner MCP surface through the one gate (arch A3c; since A5 step 4 the
 * surface registers through it, gated-tools.ts): for every tool the surface
 * has and every kind of caller, what registerPreparedTools registers is
 * exactly what the gate lists (steps 3 to 5, with the policies
 * gate-policy.ts registers and the narrowers of @mantle/tools
 * gate-narrowers.ts), and the call runs exactly when the listing shows it.
 * That the listing is the one before A5 step 4 is the snapshot's
 * (mcp-surface-snapshot.test.ts, tools-list.matrix.json). No database: each
 * caller carries the create-home fallback its connection resolved.
 */
import { describe, expect, it, vi } from 'vitest';

// Each call enters the login's scope (mcp-scope.ts): one workspace, no
// database (the scope entry is the gate's step 3, pinned elsewhere).
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  brainOnWorkspacesNow: async () => true,
  loginScopeFor: async (loginId: string) => ({
    kind: 'user',
    loginId,
    ws: ['10000000-0000-4000-8000-000000000001'],
    modWs: [],
  }),
}));
import {
  enterCall,
  gateCheck,
  gateLists,
  type PolicyRef,
  type ScopeArea,
  type Tool,
  type ToolHandler,
} from '@mantle/db';
import {
  BUILTIN_TOOLS,
  externalAccessToolSig,
  mcpBuiltinToolRef,
  type AdminGateView,
} from '@mantle/tools';
import { mcpDefinition } from './mcp-defs';
import { NO_WORKSPACE_CREATE_ERROR } from './create-home';
import { registerMantleTools } from './build-server';
import { mcpGateCaller, mcpToolPolicy } from './gate-policy';
import {
  preparedLists,
  registerPreparedTools,
  type McpCaller,
  type PreparedCallerTools,
} from './login-surface';

const LOGIN = '00000000-0000-4000-8000-0000000000aa';
const BUILTIN = new Set(BUILTIN_TOOLS.map((d) => d.slug));

/** Every name the owner surface registers (a capturing fake server). */
function registered(): string[] {
  const out: string[] = [];
  const fakeServer = { registerTool: (name: string) => void out.push(name) };
  registerMantleTools(fakeServer as never, 'owner-1', { transport: 'stdio' });
  return out;
}

const AREAS: ScopeArea[] = ['settings', 'users', 'assistants', 'connectors', 'keys'];

/** A matrix of connections: each login kind, credential and scope. */
function preparedMatrix(): PreparedCallerTools[] {
  // The unscoped connection (an Admin login on a brain not on workspaces)
  // goes with the switch-over code in arch A7: recorded on main without it.
  const views: (AdminGateView | null)[] = [
    { holdsAdmin: false, areas: new Set<ScopeArea>() },
    { holdsAdmin: true, areas: new Set<ScopeArea>(AREAS) },
    { holdsAdmin: true, areas: new Set<ScopeArea>(['settings']) },
    { holdsAdmin: true, areas: new Set<ScopeArea>() },
  ];
  const callers: McpCaller[] = [];
  for (const role of ['admin', 'member'] as const) {
    for (const write of [true, false]) {
      callers.push({ role, anchorId: 'a', loginId: LOGIN, via: 'oauth', write });
      for (const areas of [null, ['pages', 'search'], ['app_data'], []]) {
        callers.push({ role, anchorId: 'a', loginId: LOGIN, via: 'key', write, areas, keyId: 'k' });
      }
      for (const riskyAllowed of [[], ['email_send', 'web_crawl', 'telegram_send']]) {
        callers.push({ role, anchorId: 'a', loginId: LOGIN, via: 'peer', write, riskyAllowed });
      }
    }
  }
  const out: PreparedCallerTools[] = [];
  for (const caller of callers) {
    for (const view of views) {
      out.push({ kind: 'owner', caller, view, privateWs: null, connectors: [] });
    }
  }
  return out;
}

const label = (p: PreparedCallerTools) =>
  p.kind === 'owner'
    ? `${p.caller.role}/${p.caller.via}/${p.caller.write ? 'rw' : 'ro'}/${JSON.stringify(p.caller.areas ?? null)}/${JSON.stringify(p.caller.riskyAllowed ?? [])}/${p.view ? `${p.view.holdsAdmin}:${[...p.view.areas].join(',')}` : 'unscoped'}`
    : 'refused';

describe('the MCP tool policy', () => {
  it('every registered tool has one, declared (a builtin, or a hand-written definition); else none', () => {
    for (const d of BUILTIN_TOOLS)
      expect(mcpToolPolicy({ kind: 'mcp-tool', name: d.slug }), d.slug).not.toBeNull();
    const handWritten = registered().filter((n) => !BUILTIN.has(n));
    expect(handWritten).toContain('search');
    for (const name of handWritten) {
      expect(mcpToolPolicy({ kind: 'mcp-tool', name }), name).not.toBeNull();
    }
    expect(mcpToolPolicy({ kind: 'mcp-tool', name: 'search' })).toMatchObject({
      effect: 'read',
      scope: 'any',
      fields: { keyArea: 'search', peerRisky: false },
    });
    expect(mcpToolPolicy({ kind: 'mcp-tool', name: 'no_such_tool' })).toBeNull();
    // A connector's tool is a runtime row, never an mcp-tool entry.
    expect(mcpToolPolicy({ kind: 'mcp-tool', name: 'mcp_crm_contacts_list' })).toBeNull();
  });

  it('a refused connection has no gate caller', () => {
    expect(
      mcpGateCaller({
        kind: 'refused',
        caller: { role: 'member', anchorId: 'a', loginId: LOGIN, via: 'oauth', write: true },
        message: 'no',
      }),
    ).toBeNull();
  });
});

describe('what the surface registers is what the gate lists (A5 step 4)', () => {
  const names = registered();
  /** The ref the surface lists a tool by: a hand-written definition's, a
   *  builtin's (the builtin it runs). */
  const refOf = (slug: string): PolicyRef =>
    mcpDefinition(slug) ? { kind: 'mcp-tool', name: slug } : mcpBuiltinToolRef(slug, slug);
  const registeredFor = (p: PreparedCallerTools): string[] => {
    const out: string[] = [];
    registerPreparedTools({ registerTool: (n: string) => void out.push(n) } as never, p, {
      transport: 'stdio',
    });
    return out;
  };

  it('for every registered tool and every connection', () => {
    expect(names.length).toBeGreaterThan(200);
    let cells = 0;
    for (const p of preparedMatrix()) {
      const caller = mcpGateCaller(p)!;
      const listed = new Set(registeredFor(p));
      for (const slug of names) {
        const lists = gateLists(caller, refOf(slug));
        expect(listed.has(slug), `${label(p)} ${slug}`).toBe(lists);
        expect(preparedLists(p, slug), `${label(p)} ${slug}`).toBe(lists);
        cells += 1;
      }
    }
    expect(cells).toBeGreaterThan(10_000);
  });

  it('for the connector tools of the login: marked, or the connection writes', () => {
    const changed: string[] = [];
    const handler: ToolHandler = { kind: 'mcp', group: 'crm', toolName: 'contacts_list' };
    const base = {
      slug: 'mcp_crm_contacts_list',
      description: 'List contacts.',
      inputSchema: { type: 'object', properties: {} },
      handler,
      requiresConfirm: false,
      externalAccess: null,
    } as unknown as Tool;
    const marked = {
      ...base,
      externalAccess: {
        confirmedReadOnlyAt: new Date(0).toISOString(),
        by: { via: 'web' },
        handlerSig: externalAccessToolSig(base),
      },
    } as Tool;
    for (const p of preparedMatrix()) {
      if (p.kind !== 'owner') continue;
      for (const [row, readOnly] of [
        [base, false],
        [marked, true],
      ] as const) {
        const withRow = { ...p, connectors: [row] };
        const caller = mcpGateCaller(withRow)!;
        // What prepareCallerTools kept, then registerPreparedTools listed,
        // before A5 step 4: the row when it reads or the connection writes,
        // and only for an all-areas key (a connector is in no key area).
        const before =
          (readOnly || p.caller.write) &&
          (p.caller.areas ?? null) === null &&
          (p.caller.via === 'oauth' || p.caller.write);
        // A5 step 5 (owner decision Q1 b): a read-only key or peer lists a
        // connector tool an Admin marked read-only, as a read-only OAuth
        // login does; the key area rule stays.
        const now = (readOnly || p.caller.write) && (p.caller.areas ?? null) === null;
        const ref: PolicyRef = { kind: 'runtime-tool', name: row.slug, row };
        const lists = gateLists(caller, ref);
        const cell = `${label(p)} ${readOnly ? 'marked' : 'unmarked'}`;
        expect(lists, cell).toBe(now);
        expect(registeredFor(withRow).includes(row.slug)).toBe(lists);
        if (now !== before) changed.push(cell);
      }
    }
    // Only the cells of a key or a peer with Write off and a marked
    // connector tool changed, each from hidden to listed.
    expect(changed.length).toBeGreaterThan(0);
    for (const p of preparedMatrix()) {
      if (p.kind !== 'owner') continue;
      const cell = `${label(p)} marked`;
      const expected =
        (p.caller.via === 'key' || p.caller.via === 'peer') &&
        !p.caller.write &&
        (p.caller.areas ?? null) === null;
      expect(changed.includes(cell), cell).toBe(expected);
    }
    expect(changed.every((c) => c.endsWith(' marked'))).toBe(true);
  });
});

describe('calling through the gate equals listing', () => {
  it('the call runs exactly when the listing shows it, with the listing refusal', async () => {
    const names = registered();
    for (const p of preparedMatrix()) {
      const caller = mcpGateCaller(p)!;
      for (const slug of names) {
        const ref: PolicyRef = { kind: 'mcp-tool', name: slug };
        const listed = gateCheck(caller, ref);
        const called = await enterCall(caller, ref, async () => 'ran');
        // A connection with no home for an item lists its creates and
        // refuses each at step 6, with a reply that says why (W7b fix round
        // 2): the one call the listing does not foresee.
        const noHome = !!caller.createHome?.refuseCreates && !!mcpToolPolicy(ref)?.creates;
        if (listed === null && noHome) {
          expect(called.ok, `${label(p)} ${slug}`).toBe(false);
          if (!called.ok) expect(called.refusal.toolText).toBe(NO_WORKSPACE_CREATE_ERROR);
        } else if (listed === null) {
          expect(called, `${label(p)} ${slug}`).toEqual({ ok: true, value: 'ran' });
        } else {
          expect(called.ok, `${label(p)} ${slug}`).toBe(false);
          if (!called.ok) expect(called.refusal.toolText).toBe(listed.message);
        }
      }
    }
  });
});

describe('one no-workspace refusal (fix round 2, L-a)', () => {
  it("the gate's no-scope refusal is the owner MCP surface's, in today's words", async () => {
    const { NO_SCOPE_ERROR } = await import('@mantle/std');
    const { NO_WORKSPACE_ERROR } = await import('./mcp-scope');
    expect(NO_WORKSPACE_ERROR).toBe(NO_SCOPE_ERROR);
    expect(NO_WORKSPACE_ERROR).toBe(
      'This login is a user of no workspace on this brain, so its MCP reads nothing. Ask an admin to add it to one.',
    );
  });
});
