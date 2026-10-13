/**
 * The owner MCP surface through the one gate (arch A3c): for every tool the
 * surface registers and every kind of caller, the gate's listing (steps 3
 * to 5, with the policies and narrowers gate-policy.ts registers) is what
 * preparedAllows lists today, and the call runs exactly when the listing
 * shows it. The contract A5 moves MCP registration onto. No database: each
 * caller carries the create-home fallback its connection resolved.
 */
import { describe, expect, it } from 'vitest';
import {
  enterCall,
  gateCheck,
  gateLists,
  type PolicyRef,
  type ScopeArea,
  type Tool,
  type ToolHandler,
} from '@mantle/db';
import { BUILTIN_TOOLS, externalAccessToolSig, type AdminGateView } from '@mantle/tools';
import { registerMantleTools } from './build-server';
import { mcpGateCaller, mcpToolPolicy } from './gate-policy';
import {
  callerAreasAllow,
  preparedAllows,
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
  const views: (AdminGateView | null)[] = [
    null,
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
  it('every built-in has one; a hand-written tool only when its registration says so; else none', () => {
    for (const d of BUILTIN_TOOLS)
      expect(mcpToolPolicy({ kind: 'mcp-tool', name: d.slug }), d.slug).not.toBeNull();
    const handWritten = registered().filter((n) => !BUILTIN.has(n));
    expect(handWritten).toContain('search');
    for (const name of handWritten) {
      expect(mcpToolPolicy({ kind: 'mcp-tool', name }), name).toBeNull();
      expect(mcpToolPolicy({ kind: 'mcp-tool', name, handWritten: true }), name).not.toBeNull();
    }
    expect(mcpToolPolicy({ kind: 'mcp-tool', name: 'search', handWritten: true })).toMatchObject({
      effect: 'read',
      scope: 'any',
      fields: { keyArea: 'search', peerRisky: false },
    });
    expect(mcpToolPolicy({ kind: 'mcp-tool', name: 'no_such_tool' })).toBeNull();
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

describe('listing through the gate equals the listing today (preparedAllows)', () => {
  const names = registered();
  const refOf = (slug: string): PolicyRef => ({
    kind: 'mcp-tool',
    name: slug,
    ...(BUILTIN.has(slug) ? {} : { handWritten: true }),
  });

  it('for every registered tool and every connection', () => {
    expect(names.length).toBeGreaterThan(200);
    let cells = 0;
    for (const p of preparedMatrix()) {
      const caller = mcpGateCaller(p)!;
      for (const slug of names) {
        expect(gateLists(caller, refOf(slug)), `${label(p)} ${slug}`).toBe(preparedAllows(p, slug));
        cells += 1;
      }
    }
    expect(cells).toBeGreaterThan(10_000);
  });

  it('for the connector tools a connection was given (marked, or the connection writes)', () => {
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
      const caller = mcpGateCaller(p)!;
      for (const [row, readOnly] of [
        [base, false],
        [marked, true],
      ] as const) {
        // What prepareCallerTools keeps, then what registerPreparedTools lists.
        const today =
          (readOnly || p.caller.write) &&
          callerAreasAllow(row.slug, p.caller) &&
          preparedAllows(p, row.slug, { connector: true });
        const ref: PolicyRef = { kind: 'runtime-tool', name: row.slug, row };
        expect(gateLists(caller, ref), `${label(p)} ${readOnly ? 'marked' : 'unmarked'}`).toBe(
          today,
        );
      }
    }
  });
});

describe('calling through the gate equals listing', () => {
  it('the call runs exactly when the listing shows it, with the listing refusal', async () => {
    const names = registered();
    for (const p of preparedMatrix()) {
      const caller = mcpGateCaller(p)!;
      for (const slug of names) {
        const ref: PolicyRef = {
          kind: 'mcp-tool',
          name: slug,
          ...(BUILTIN.has(slug) ? {} : { handWritten: true }),
        };
        const listed = gateCheck(caller, ref);
        const called = await enterCall(caller, ref, async () => 'ran');
        if (listed === null) {
          expect(called, `${label(p)} ${slug}`).toEqual({ ok: true, value: 'ran' });
        } else {
          expect(called.ok, `${label(p)} ${slug}`).toBe(false);
          if (!called.ok) expect(called.refusal.toolText).toBe(listed.message);
        }
      }
    }
  });
});
