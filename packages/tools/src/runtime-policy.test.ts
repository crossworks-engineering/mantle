/**
 * The runtime tool row policies (arch A3c, plan section 8): one function
 * per row type, each at today's behaviour; no runtime tool runs without
 * one; and through the gate (@mantle/db gate.ts) the listing of a runtime
 * tool equals its calling.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  enterCall,
  gateCheck,
  loginActor,
  registerNarrower,
  systemActor,
  type GateCaller,
  type GatePolicy,
  type PolicyRef,
  type Tool,
  type ToolHandler,
} from '@mantle/db';
import { externalAccessToolSig } from './external-access';
import { MEMBER_APP_REFUSED_SLUGS } from './member-app-tools';
import {
  NO_RUNTIME_POLICY_ERROR,
  apiToolPolicy,
  appToolPolicy,
  connectorToolPolicy,
  peerToolPolicy,
  recipeToolPolicy,
  runtimeToolPolicy,
  sandboxMcpToolPolicy,
  shellToolPolicy,
} from './runtime-policy';
import { dispatchTool } from './dispatch';

const MCP: ToolHandler = { kind: 'mcp', group: 'crm', toolName: 'lookup' };
const HTTP: ToolHandler = { kind: 'http', url: 'https://api.example.test/v1/{q}', method: 'GET' };
const HTTP_SECRET: ToolHandler = {
  kind: 'http',
  url: 'https://api.example.test/v1',
  headers: { Authorization: 'Bearer {{secret:crm/main}}' },
};
const RECIPE: ToolHandler = {
  kind: 'recipe',
  steps: [{ tool: 'search_nodes' }, { tool: 'calculate' }],
};
const SHELL: ToolHandler = { kind: 'shell', cmd: 'echo ${input.x}' };

function row(handler: ToolHandler, over: Partial<Tool> = {}): Tool {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    ownerId: '00000000-0000-4000-8000-000000000002',
    slug: 'mcp_crm_lookup',
    name: 'Lookup',
    description: 'Look a customer up.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    handler,
    requiresConfirm: false,
    enabled: true,
    externalAccess: null,
    createdBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as Tool;
}

/** A row with the admin's read-only mark on what it is now. */
function marked(handler: ToolHandler): Tool {
  const t = row(handler);
  return {
    ...t,
    externalAccess: {
      confirmedReadOnlyAt: new Date(0).toISOString(),
      by: { via: 'web' },
      handlerSig: externalAccessToolSig(t),
    },
  };
}

/** A row whose mark was taken on another handler (stale). */
function stale(handler: ToolHandler): Tool {
  return {
    ...row(handler),
    externalAccess: {
      confirmedReadOnlyAt: new Date(0).toISOString(),
      by: { via: 'web' },
      handlerSig: 'v2:not-this-one',
    },
  };
}

describe('one function per runtime row type', () => {
  it('every runtime handler kind has a policy; a built-in and an unknown kind have none', () => {
    expect(runtimeToolPolicy(row(MCP))?.rowType).toBe('connector');
    expect(runtimeToolPolicy(row(HTTP))?.rowType).toBe('api');
    expect(runtimeToolPolicy(row(RECIPE))?.rowType).toBe('recipe');
    expect(runtimeToolPolicy(row(SHELL))?.rowType).toBe('shell');
    expect(runtimeToolPolicy(row({ kind: 'builtin', ref: 'search_nodes' }))).toBeNull();
    expect(runtimeToolPolicy(row({ kind: 'ftp' } as unknown as ToolHandler))).toBeNull();
  });

  it('a connector: the read-only mark is a read; none, or a stale one, a write', () => {
    expect(connectorToolPolicy(row(MCP))).toMatchObject({
      effect: 'write',
      scope: 'any',
      fields: { mark: 'write', resource: { type: 'connector', ref: 'crm', writeTick: true } },
    });
    expect(connectorToolPolicy(marked(MCP))).toMatchObject({
      effect: 'read',
      fields: { mark: 'read', resource: { ref: 'crm', writeTick: false } },
    });
    expect(connectorToolPolicy(stale(MCP))).toMatchObject({
      effect: 'write',
      fields: { mark: 'stale', resource: { writeTick: true } },
    });
  });

  it('an API tool: a write, unless External access is on; its vault refs and maker named', () => {
    expect(apiToolPolicy(row(HTTP))).toMatchObject({
      effect: 'write',
      fields: { outside: 'http', externalAccess: false, secretRefs: false, maker: null },
    });
    expect(apiToolPolicy(marked(HTTP)).effect).toBe('read');
    const maker = '00000000-0000-4000-8000-000000000003';
    expect(apiToolPolicy(row(HTTP_SECRET, { createdBy: maker })).fields).toMatchObject({
      secretRefs: true,
      maker,
    });
  });

  it('a recipe and a shell tool: writes', () => {
    expect(recipeToolPolicy(row(RECIPE))).toMatchObject({
      effect: 'write',
      fields: { recipe: true, steps: 2 },
    });
    expect(shellToolPolicy(row(SHELL))).toMatchObject({
      effect: 'write',
      fields: { outside: 'shell' },
    });
  });

  it('a sandbox toolbelt tool and a peer tool: the area of the builtin that calls them', () => {
    expect(sandboxMcpToolPolicy('')).toBeNull();
    expect(sandboxMcpToolPolicy('Bash')).toMatchObject({
      effect: 'write',
      scope: { area: 'settings' },
      fields: { remote: 'Bash' },
    });
    expect(peerToolPolicy('')).toBeNull();
    expect(peerToolPolicy('note_create')).toMatchObject({
      effect: 'write',
      scope: { area: 'connectors' },
      fields: { peerRisky: true },
    });
  });
});

describe('a tool an app calls: the member-app rule, as memberAppToolVerdict said it', () => {
  const b = (slug: string, ref = slug) => row({ kind: 'builtin', ref }, { slug });
  const rule = (t: Tool, readOnly: boolean, spends: boolean) =>
    appToolPolicy(t, { readOnly, spends }, MEMBER_APP_REFUSED_SLUGS)?.fields?.memberApp;

  it('a read-only built-in that spends nothing runs', () => {
    expect(appToolPolicy(b('page_get'), { readOnly: true, spends: false }, [])).toMatchObject({
      rowType: 'app',
      effect: 'read',
      spends: 'none',
      fields: { memberApp: null },
    });
  });

  it('each refusal in the old order and words', () => {
    expect(rule(b('alias', 'my_items_list'), true, false)).toBe(
      "The tool 'alias' is not available in team apps.",
    );
    // A refused slug over another builtin: refused by its slug too (rule 2
    // checks both, as memberAppToolVerdict does before any lookup).
    expect(rule(b('my_items_list', 'page_get'), true, false)).toBe(
      "The tool 'my_items_list' is not available in team apps.",
    );
    expect(rule(b('web_search'), true, true)).toBe(
      "The tool 'web_search' starts paid model work on every call, so a team app can't use it.",
    );
    expect(rule(b('page_update'), false, false)).toBe(
      "The tool 'page_update' changes data or reaches outside the brain, so a team app can't use it (only read-only built-in tools are).",
    );
    expect(rule({ ...b('page_get'), requiresConfirm: true }, true, false)).toBe(
      "The tool 'page_get' needs an admin's confirmation, so a team app can't use it.",
    );
    // Spending is said before writing, as before.
    expect(rule(b('video_ingest'), false, true)).toContain('starts paid model work');
  });

  it('an outside tool: its own row type', () => {
    expect(appToolPolicy(row(MCP), null, [])?.rowType).toBe('connector');
    expect(appToolPolicy(row(HTTP), null, [])?.rowType).toBe('api');
  });
});

describe('no runtime tool runs without a policy', () => {
  it('dispatch refuses a row whose handler kind no function knows', async () => {
    const res = await dispatchTool(
      row({ kind: 'ftp' } as unknown as ToolHandler),
      {},
      {
        ownerId: '00000000-0000-4000-8000-000000000002',
      },
    );
    expect(res).toEqual({ ok: false, error: NO_RUNTIME_POLICY_ERROR });
  });
});

describe('through the gate', () => {
  const LOGIN = '00000000-0000-4000-8000-000000000009';
  const runtime = (t: Tool): PolicyRef => ({ kind: 'runtime-tool', name: t.slug, row: t });

  // The real narrowers (gate-narrowers.ts) are not loaded here: the key
  // narrower records the policy the gate looked up, the others pass. The
  // real ones are proven in gate-narrowers.test.ts and
  // member-app-parity.test.ts.
  let seen: GatePolicy | null = null;
  beforeAll(() => {
    registerNarrower('key', (_c, policy) => {
      seen = policy;
      return null;
    });
    registerNarrower('peer', () => null);
    registerNarrower('member-app', () => null);
    registerNarrower('spending', () => null);
    registerNarrower('turn-caps', () => null);
  });

  it('the sources are registered: a runtime row, a sandbox tool, a peer tool', () => {
    const policyOf = (r: PolicyRef) => {
      seen = null;
      expect(gateCheck(caller({ admin: null }), r)).toBeNull();
      return seen;
    };
    expect(policyOf(runtime(marked(MCP)))).toEqual(connectorToolPolicy(marked(MCP)));
    expect(policyOf({ kind: 'sandbox-mcp-tool', name: 'Bash' })).toEqual(
      sandboxMcpToolPolicy('Bash'),
    );
    expect(policyOf({ kind: 'peer-tool', name: 'x' })).toEqual(peerToolPolicy('x'));
    expect(gateCheck(caller(), { kind: 'runtime-tool', name: 'x' })?.kind).toBe('unclassified');
    expect(gateCheck(caller(), { kind: 'peer-tool', name: '' })?.kind).toBe('unclassified');
  });

  function caller(over: Partial<GateCaller> = {}): GateCaller {
    return {
      actor: loginActor(LOGIN, 'rw'),
      via: 'key',
      loginId: LOGIN,
      admin: { holdsAdmin: false, areas: new Set() },
      // Resolved when it connected: no database for the create home here.
      createFallback: { privateWs: null },
      ...over,
    };
  }

  it('listing equals calling, for every runtime row and caller', async () => {
    const refs: PolicyRef[] = [
      runtime(row(MCP)),
      runtime(marked(MCP)),
      runtime(stale(MCP)),
      runtime(row(HTTP)),
      runtime(marked(HTTP)),
      runtime(row(RECIPE)),
      runtime(row(SHELL)),
      runtime(row({ kind: 'ftp' } as unknown as ToolHandler)),
      { kind: 'sandbox-mcp-tool', name: 'Bash' },
      { kind: 'peer-tool', name: 'note_create' },
    ];
    const callers: GateCaller[] = [
      caller(),
      caller({ write: false }),
      caller({ admin: { holdsAdmin: true, areas: new Set(['settings']) } }),
      caller({ admin: { holdsAdmin: true, areas: new Set(['connectors']) } }),
      caller({ admin: null }),
      { actor: systemActor('worker:runs'), via: 'process', admin: null },
    ];
    for (const c of callers) {
      for (const r of refs) {
        const listed = gateCheck(c, r);
        const called = await enterCall(c, r, async () => 'ran');
        expect(called.ok, `${c.via} ${String(c.write)} ${r.name}`).toBe(listed === null);
      }
    }
    // A read-only key lists a marked connector tool, not an unmarked one.
    expect(gateCheck(caller({ write: false }), runtime(marked(MCP)))).toBeNull();
    expect(gateCheck(caller({ write: false }), runtime(row(MCP)))?.kind).toBe('narrowed');
  });
});
