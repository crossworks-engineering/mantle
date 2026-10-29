/**
 * Dispatch parity (workspaces arch A5 step 3a): what dispatchTool answers for
 * every built-in tool and every runtime row type, for each kind of caller,
 * recorded on main BEFORE dispatch moved onto the one gate, and held equal
 * after it. Step 3a changes no behaviour, so every answer stays byte for
 * byte: the {ok:false,error} text, whether the handler ran, the create home
 * it ran under, whether it ran whole on the system pool, the trace meta
 * dispatch sets, and the create-home intents asked. The pending rows and the
 * run item rows are written from the dispatch result (pending.ts,
 * execute-item.ts), so they follow it.
 *
 * The callers are the ambient state each entry dispatches in: an owner
 * turn (an Admin turn with every area), a member turn (a workspace that is
 * not Admin, a team surface), an Admin turn without an area, a run item, a
 * pending approval from the web (a user scope), work outside any scope, and
 * a recipe step. The turn on the rollback switch (a gate scope) went with
 * the switch in arch A7: its cases were taken out of every hash, recorded
 * on main before the switch-over code went. Each case
 * passes the entry's gate caller when the build has one (A5 step 3a:
 * turnCaller, runCaller, pendingCaller); main had none and ignores it.
 *
 * What a tool's handler does is not under test (it is stubbed): what
 * dispatch decides around it is. The database is stubbed: the scope, the
 * Admin view, the create-home intent, the item rights and the
 * preconditions. One hash per tool and per runtime case is committed
 * (__snapshots__/dispatch-parity.json); a change names the tool. The
 * pre-check removal re-recorded the 56 tools whose item pre-check went and
 * whose cases reach it (an item the stubbed rights refuse now runs the
 * handler: the database refuses it); every other hash stands. Workspace
 * delegation (owner decision
 * 2026-10-26) re-recorded the 23 app tools alone: they carry `loginTurns`,
 * so the member turn (a team surface naming the login its turn scope
 * answers) runs them where the owner-only gate refused it before.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: null as null | Record<string, unknown>,
  view: { holdsAdmin: false, areas: new Set<string>() },
  privateWs: null as string | null,
  member: [] as string[],
  moderated: [] as string[],
  intents: [] as unknown[],
  meta: [] as unknown[],
  ran: [] as unknown[],
  held: [] as { workspaceId: string; write: boolean }[],
  /** Outside the hash (A5 step 3a only): the gate caller and the write
   *  mode each handler ran with. */
  seen: [] as { slug: string; via: string | null; mode: string | null }[],
}));

vi.mock('../../db/src/viewer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/src/viewer')>();
  return {
    ...real,
    currentWorkspaceScope: () => h.scope ?? real.currentWorkspaceScope(),
  };
});
vi.mock('../../db/src/gateway/scope-answers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/src/gateway/scope-answers')>()),
  scopeHoldsAdmin: async () => h.view.holdsAdmin,
  adminOrSystemScope: async () =>
    !(await import('../../db/src/viewer')).currentWorkspaceScope() || h.view.holdsAdmin,
  scopeHasArea: async (a: string) => h.view.holdsAdmin && h.view.areas.has(a),
  // No database: every Moderator seat a turn holds is held still (A8 L5).
  moderatorSeatsNow: async (_l: string, ws: readonly string[]) => [...ws],
  loginHasArea: async (_l: string, a: string) => h.view.areas.has(a),
}));
vi.mock('../../db/src/gateway/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/src/gateway/scope')>()),
  // A scope entered (a left scope's checks): they run in it.
  withTurnScope: async (s: Record<string, unknown>, fn: () => Promise<unknown>) => {
    const prev = h.scope;
    h.scope = s;
    try {
      return await fn();
    } finally {
      h.scope = prev;
    }
  },
}));
vi.mock('../../db/src/create-home', () => ({
  createHomeIntent: vi.fn(async (...args: unknown[]) => {
    h.intents.push(args);
    const [, ask, fb] = args as [
      string,
      { ws: string | null } | null,
      { ownWork: unknown; makePrivate: boolean } | { privateWs: string | null },
    ];
    const ws = ask?.ws ?? null;
    if (ws && !h.member.includes(ws)) return { refused: 'not-member', message: 'not in it' };
    const createWs = ws && h.moderated.includes(ws) ? ws : null;
    if ('privateWs' in fb) return { createWs, privateWs: fb.privateWs };
    if (fb.ownWork === false) return { createWs, privateWs: null };
    if (fb.makePrivate && !h.privateWs) h.privateWs = PRIVATE;
    return { createWs, privateWs: h.privateWs };
  }),
}));
vi.mock('../../db/src/item-rights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/src/item-rights')>()),
  itemWriteRefusal: async (ids: string[], need: string) =>
    ids.includes(REFUSED_ID) ? `item refused (${need})` : null,
  // The same refusal with its edit check detail (A5 step 4 fix round 2:
  // the item pre-check asks this one; a /api/v1 route reads the detail).
  itemWriteRefusalOf: async (ids: string[], need: string) =>
    ids.includes(REFUSED_ID) ? { message: `item refused (${need})`, detail: 'no_edit' } : null,
}));
vi.mock('@mantle/db', async (importOriginal) => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => [
      {
        slug: 'conn',
        ownerId: OWNER,
        enabled: true,
        integration: { mcp: { url: 'https://mcp.example.test' } },
        configuredBy: null,
      },
    ],
  };
  // The connector's state by its definer (A6b: mantle_connector_state):
  // the same fixture row, as its state.
  const execute = async (stmt: { queryChunks?: unknown[] }) => {
    const text = JSON.stringify(stmt.queryChunks ?? []);
    if (text.includes('mantle_connector_state')) return [{ slug: 'conn', usable: true }];
    throw new Error(`unexpected statement in the parity mock: ${text.slice(0, 200)}`);
  };
  return { ...(await importOriginal<Record<string, unknown>>()), db: { ...chain, execute } };
});
vi.mock('@mantle/api-keys', () => ({ getApiKey: async () => null }));
vi.mock('./preconditions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./preconditions')>()),
  checkToolPreconditions: async (_pre: unknown, input: Record<string, unknown>) =>
    input.__pre === 'fail' ? { ok: false, error: 'precondition failed: pass a real id' } : null,
}));
vi.mock('./external-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./external-access')>()),
  connectorResources: async () => h.held,
  loginConnectorRefused: async (_o: string, _l: string, _g: string, write: boolean) =>
    write ? 'login connector refused (write)' : null,
}));
vi.mock('./mcp-client', () => ({
  mcpCallRemoteTool: async (_o: string, group: string, _m: unknown, tool: string) => ({
    text: JSON.stringify({ group, tool }),
    isError: false,
    secrets: new Map(),
  }),
}));
vi.mock('./safe-fetch', () => ({
  safeFetch: async () =>
    new Response('{"fetched":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
}));
vi.mock('./resolve', () => ({
  resolveTool: async (_o: string, slug: string) => recipeRow(slug),
  resolveTools: async () => [],
}));
vi.mock('./registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('./registry')>();
  return {
    ...real,
    // Every handler is a recorder: what dispatch decided around the call.
    getBuiltinHandler: (slug: string) =>
      real.getBuiltinHandler(slug)
        ? async (input: Record<string, unknown>) => {
            const db = await import('@mantle/db');
            const actor = db.currentActor();
            h.ran.push({
              slug,
              home: db.currentCreateHome(),
              system: actor?.kind === 'system' ? actor.reason : null,
            });
            h.seen.push({
              slug,
              via: db.currentCaller()?.via ?? null,
              mode: actor ? db.writeModeOf(actor) : null,
            });
            return input.__throw
              ? Promise.reject(new Error(`handler threw: ${slug}`))
              : { ok: true, output: { ran: slug } };
          }
        : null,
  };
});

import type { Tool } from '@mantle/db';
import { loginActor, runAsActor, withCreateHome } from '@mantle/db';
import * as tools from './index';
import { BUILTIN_TOOLS, dispatchTool } from './index';
import type { ToolHandlerContext } from './types';

const OWNER = '99999999-9999-4999-8999-999999999999';
const LOGIN = '55555555-5555-4555-8555-555555555555';
const MEMBER = '66666666-6666-4666-8666-666666666666';
const ADMIN_WS = '11111111-1111-4111-8111-111111111111';
const TEAM_WS = '22222222-2222-4222-8222-222222222222';
const PRIVATE = '77777777-7777-4777-8777-777777777777';
const REFUSED_ID = '44444444-4444-4444-8444-444444444444';
const AREAS = ['settings', 'users', 'assistants', 'connectors', 'keys'];

function builtinRow(slug: string): Tool {
  const def = BUILTIN_TOOLS.find((d) => d.slug === slug);
  return {
    slug,
    ownerId: OWNER,
    handler: { kind: 'builtin', ref: slug },
    requiresConfirm: def?.requiresConfirm === true,
    inputSchema: { type: 'object', properties: {} },
    description: '',
    externalAccess: null,
  } as unknown as Tool;
}

/** What a recipe step resolves to: the builtin of that slug. */
function recipeRow(slug: string): Tool | null {
  return BUILTIN_TOOLS.some((d) => d.slug === slug) ? builtinRow(slug) : null;
}

type CallerKind =
  | 'owner-turn'
  | 'member-turn'
  | 'admin-turn-no-area'
  | 'run'
  | 'pending'
  | 'unscoped'
  | 'recipe-step';

const CALLERS: readonly CallerKind[] = [
  'owner-turn',
  'member-turn',
  'admin-turn-no-area',
  'run',
  'pending',
  'unscoped',
  'recipe-step',
];

/** The ambient state of one caller kind, set fresh for every call. */
function enter(kind: CallerKind): { surface: ToolHandlerContext['surface']; login: string } {
  h.scope = null;
  h.privateWs = null;
  h.member = [ADMIN_WS, TEAM_WS];
  h.moderated = [ADMIN_WS];
  h.held = [{ workspaceId: ADMIN_WS, write: true }];
  const admin = { holdsAdmin: true, areas: new Set(AREAS) };
  switch (kind) {
    case 'owner-turn':
    case 'recipe-step':
      h.view = admin;
      h.scope = { kind: 'assistant', loginId: LOGIN, ws: [ADMIN_WS], modWs: [ADMIN_WS] };
      return { surface: { kind: 'web', loginId: LOGIN }, login: LOGIN };
    case 'member-turn':
      h.view = { holdsAdmin: false, areas: new Set() };
      h.moderated = [];
      h.held = [{ workspaceId: TEAM_WS, write: false }];
      h.scope = { kind: 'assistant', loginId: MEMBER, ws: [TEAM_WS], modWs: [] };
      return { surface: { kind: 'team', loginId: MEMBER }, login: MEMBER };
    case 'admin-turn-no-area':
      h.view = { holdsAdmin: true, areas: new Set() };
      h.scope = { kind: 'assistant', loginId: LOGIN, ws: [ADMIN_WS], modWs: [ADMIN_WS] };
      return { surface: { kind: 'web', loginId: LOGIN }, login: LOGIN };
    case 'run':
      h.view = admin;
      h.scope = { kind: 'assistant', loginId: LOGIN, ws: [ADMIN_WS], modWs: [ADMIN_WS] };
      return {
        surface: { kind: 'owner', via: 'run', loginId: LOGIN } as ToolHandlerContext['surface'],
        login: LOGIN,
      };
    case 'pending':
      h.view = admin;
      h.scope = { kind: 'user', loginId: LOGIN, ws: [ADMIN_WS], modWs: [ADMIN_WS] };
      return {
        surface: { kind: 'owner', via: 'pending', loginId: LOGIN } as ToolHandlerContext['surface'],
        login: LOGIN,
      };
    case 'unscoped':
      h.view = { holdsAdmin: false, areas: new Set() };
      return { surface: undefined, login: LOGIN };
  }
}

/** The entry's gate caller, when this build has one (A5 step 3a). */
function entryCaller(kind: CallerKind): unknown {
  const t = tools as unknown as Record<string, undefined | (() => unknown)>;
  const pick = kind === 'run' ? 'runCaller' : kind === 'pending' ? 'pendingCaller' : 'turnCaller';
  return t[pick]?.();
}

/** Trace meta without timings (a recipe's `recipe_steps[].ms`). */
function untimed(m: unknown): unknown {
  const steps = (m as { recipe_steps?: unknown }).recipe_steps;
  if (!Array.isArray(steps)) return m;
  return { ...(m as object), recipe_steps: steps.map((s) => ({ ...(s as object), ms: 0 })) };
}

/** One call, recorded: the answer and what dispatch did around it. */
async function call(
  kind: CallerKind,
  tool: Tool,
  input: Record<string, unknown>,
  opts: { outerHome?: boolean } = {},
): Promise<unknown> {
  const { surface, login } = enter(kind);
  h.intents = [];
  h.meta = [];
  h.ran = [];
  const caller = entryCaller(kind);
  const ctx = {
    ownerId: OWNER,
    step: {
      setMeta: (m: Record<string, unknown>) => h.meta.push(m),
      setOutput: () => {},
    },
    ...(surface ? { surface } : {}),
    ...(caller ? { caller } : {}),
  } as ToolHandlerContext;
  const target =
    kind === 'recipe-step'
      ? ({
          slug: 'parity_recipe',
          ownerId: OWNER,
          handler: { kind: 'recipe', steps: [{ tool: tool.slug, input }] },
          requiresConfirm: false,
          inputSchema: { type: 'object', properties: {} },
        } as unknown as Tool)
      : tool;
  const run = () =>
    runAsActor(loginActor(login, 'rw'), () => dispatchTool(target, { ...input }, ctx));
  const res = await (opts.outerHome
    ? withCreateHome({ createWs: TEAM_WS, privateWs: null }, run)
    : run());
  return {
    res,
    ran: h.ran,
    intents: h.intents.map((a) => (a as unknown[]).slice(1)),
    // A recipe's step timings are no decision of dispatch: out of the hash.
    meta: h.meta.map(untimed),
  };
}

/** The inputs one builtin is called with: none, a failing precondition, a
 *  throw. (Its item targets on a refused item and a readable one went with
 *  the last tool item pre-check, pre-check removal Part 3: no builtin
 *  declares items now.) */
function inputsFor(_slug: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{}];
  out.push({ __pre: 'fail' });
  out.push({ __throw: true });
  return out;
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Runtime rows, one per type and mark. */
const RUNTIME_ROWS: Record<string, Tool> = {
  http: {
    slug: 'api_thing',
    ownerId: OWNER,
    handler: { kind: 'http', method: 'GET', url: 'https://api.example.test/x' },
    requiresConfirm: false,
    inputSchema: { type: 'object', properties: {} },
    description: '',
    externalAccess: null,
  } as unknown as Tool,
  'connector-write': {
    slug: 'mcp_conn_do',
    ownerId: OWNER,
    handler: { kind: 'mcp', group: 'conn', toolName: 'do' },
    requiresConfirm: false,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    description: 'does',
    externalAccess: null,
  } as unknown as Tool,
  shell: {
    slug: 'shell_echo',
    ownerId: OWNER,
    handler: { kind: 'shell', cmd: 'echo parity' },
    requiresConfirm: false,
    inputSchema: { type: 'object', properties: {} },
  } as unknown as Tool,
  recipe: {
    slug: 'recipe_two',
    ownerId: OWNER,
    handler: {
      kind: 'recipe',
      steps: [
        { tool: 'page_list', input: {} },
        { tool: 'note_create', input: { title: 'x' } },
      ],
    },
    requiresConfirm: false,
    inputSchema: { type: 'object', properties: {} },
  } as unknown as Tool,
  unknown: {
    slug: 'odd_kind',
    ownerId: OWNER,
    handler: { kind: 'carrier-pigeon' },
    requiresConfirm: false,
    inputSchema: { type: 'object', properties: {} },
  } as unknown as Tool,
};

describe('dispatch parity with main (A5 step 3a)', () => {
  it('every builtin, every caller kind, every input: one hash per tool', async () => {
    const out: Record<string, string> = {};
    const full: Record<string, unknown> = {};
    const slugs = BUILTIN_TOOLS.map((d) => d.slug).sort();
    for (const slug of slugs) {
      const cases: unknown[] = [];
      for (const kind of CALLERS) {
        for (const input of inputsFor(slug)) {
          cases.push(await call(kind, builtinRow(slug), input));
        }
      }
      // A home named around the call (an MCP call's, a request's).
      cases.push(await call('owner-turn', builtinRow(slug), {}, { outerHome: true }));
      out[slug] = hash(cases);
      full[slug] = cases;
    }
    for (const [name, row] of Object.entries(RUNTIME_ROWS)) {
      const cases: unknown[] = [];
      for (const kind of CALLERS) cases.push(await call(kind, row, { q: 'x' }));
      out[`runtime:${name}`] = hash(cases);
      full[`runtime:${name}`] = cases;
    }
    // PARITY_DUMP=<file>: every case in full, to diff two builds by hand.
    const dump = process.env.PARITY_DUMP;
    if (dump) writeFileSync(dump, JSON.stringify(full, null, 1));
    await expect(JSON.stringify(out, null, 1) + '\n').toMatchFileSnapshot(
      './__snapshots__/dispatch-parity.json',
    );
  }, 120_000);

  it('is not vacuous: refusals, creates and system runs all occur', async () => {
    // (No tool item pre-check is left to refuse here: the pre-check removal
    // took the last, node_share's, in Part 3, docs/actors.md.)
    const create = await call('member-turn', builtinRow('note_create'), {});
    expect(JSON.stringify(create)).toContain(PRIVATE);
    const admin = await call('member-turn', builtinRow('model_pool_list'), {});
    expect(JSON.stringify(admin)).toContain('Admin workspace');
    const whole = await call('owner-turn', builtinRow('model_pool_list'), {});
    expect(JSON.stringify(whole)).toContain('admin-area');
    const odd = await call('owner-turn', RUNTIME_ROWS.unknown!, {});
    expect(JSON.stringify(odd)).toContain('no access policy');
    // A5 step 5 (owner decision Q2 b): a shell tool runs only for a user of
    // the Admin workspace; the member turn's cell is the one that changed.
    // A5 step 5: an Admin-only kind's create is refused at the gate outside
    // Admin, before the handler runs and before any private workspace.
    const contact = await call('member-turn', builtinRow('contact_create'), {});
    expect(JSON.stringify(contact)).toContain('lives in the Admin workspace only');
    expect(JSON.stringify(contact)).toContain('"ran":[],"intents":[]');
    const shell = await call('member-turn', RUNTIME_ROWS.shell!, { q: 'x' });
    expect(JSON.stringify(shell)).toContain('it does not run in this workspace');
    const ownShell = await call('owner-turn', RUNTIME_ROWS.shell!, { q: 'x' });
    expect(JSON.stringify(ownShell)).toContain('"ok":true');
  });

  it('runs every builtin through the gate, a read read only (A5 step 3a)', async () => {
    for (const kind of ['owner-turn', 'run', 'pending', 'recipe-step'] as const) {
      for (const def of BUILTIN_TOOLS) {
        h.seen = [];
        await call(kind, builtinRow(def.slug), {});
        const seen = h.seen.find((s) => s.slug === def.slug);
        // Refused before it ran (an owner-only tool on no owner surface, a
        // confirm-gated recipe step): nothing to see.
        if (!seen) continue;
        expect(seen.via, `${kind} ${def.slug}`).toBe(kind === 'owner-turn' ? 'turn' : seen.via);
        expect(seen.via, `${kind} ${def.slug}`).not.toBeNull();
        expect(seen.mode, `${kind} ${def.slug}`).toBe(def.policy.effect === 'read' ? 'ro' : 'rw');
      }
    }
  });
});
