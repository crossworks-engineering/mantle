/**
 * App broker parity (workspaces arch A5 step 3b): what each app tool broker
 * and the dev console answer, recorded BEFORE they moved onto the one gate
 * (enterCall) and held equal after it. Step 3b changes no behaviour, so
 * every record stays as it is: the status and body each route answers, the
 * audit rows it writes (the app's Activity, the share's trail, the app's
 * error log), and what the call touched: which handler ran, with what
 * input, as which actor, in which scope, under which create home, whole on
 * the system pool or not, and each remote call (a connector's server, an
 * http tool's fetch).
 *
 * One cell changed on purpose when the brokers and the dev console moved
 * onto the gate (A5 step 3b), and only it: `mode`, the write mode of a call
 * whose policy is a read, `rw` to `ro`. The gate runs a read read only
 * (enterCall's step 3, callActor: plan 4.1), as it has for an assistant
 * turn, a run item and a pending approval since A5 step 3a; the actor
 * itself (who the call runs as) is the one bound at the broker's entry, as
 * before. Every other cell is as it was.
 *
 * A10 #9 (one runAppToolBroker, lib/app-tool-broker.ts) added audit rows
 * and changed nothing else: every call the owner's run judged lands its
 * Activity row (main logged none at admin rules, and no refusal at any),
 * and a contact link's refused or failed call lands its error row (main
 * logged none). Each added row comes after the rows main wrote, in the
 * same order (server/web/server/a10-app-broker-sweep.test.ts names them
 * cell by cell).
 *
 * The pre-check removal re-recorded two cells: page_update on the refused
 * item at the owner's admin rules and on the dev console. Its item pre-check
 * went, so the stub's refusal is not reached and the handler runs. On a box
 * neither asked it: both run as the owner with no workspace scope active (the
 * pre-check's first test), and the database refuses that write where a scope
 * is.
 *
 * The entries: the shared link broker (a contact share), a member's run of
 * an app (the owner route with a member login, lib/app-runner.ts), an
 * admin's run of an app the Admin workspace alone holds (admin rules), an
 * admin's run of an app another workspace holds (team rules), and the dev
 * console (/api/dev-tools/execute-tool). The tools: a read, a write, an item
 * write on an item the caller may and may not change, a missing tool, an
 * owner-only tool, two Admin-area tools (one runs whole on the system pool),
 * a shell tool, a connector's write and marked read, an http tool with
 * External access, a tool the app does not declare, a handler that throws,
 * and a database error (whose text no member or visitor reads).
 *
 * The rules are the real ones (appToolLevel, appToolScope, the verdicts,
 * dispatch). The database is stubbed: the scope a request and withViewer
 * enter, the Admin view, the item rights, the tool rows, the tool groups and
 * the connector's workspaces. The handlers are recorders, and the
 * preconditions are stood in (none fails) but in one case (fix round 1):
 * there the real checkToolPreconditions runs (its node lookup on the
 * stubbed database finds no page), so its words, and its place before the
 * item rights, are compared too. That case was recorded on the sources of
 * the baseline commit (the brokers off the gate) and is equal after it.
 * What a real handler does under the read-only rule, real preconditions
 * on a real database included, is
 * server/web/server/a5-read-tools-ro.db.test.ts. One JSON file holds
 * every case (__snapshots__/app-broker-parity.json); a change names the case.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const MEMBER = '66666666-6666-4666-8666-666666666666';
const APP = '77777777-7777-4777-8777-777777777777';
const ADMIN_WS = '11111111-1111-4111-8111-111111111111';
const TEAM_WS = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '88888888-8888-4888-8888-888888888888';
const REFUSED_ID = '44444444-4444-4444-8444-444444444444';
const AREAS = ['settings', 'users', 'assistants', 'connectors', 'keys'];

const SQL = 'Failed query: select "secret" from "nodes" where "id" = $1\nparams: 4f1c';

const h = vi.hoisted(() => ({
  /** The workspace scope the code runs in now (null: none). */
  scope: null as null | {
    kind: string;
    loginId: string | null;
    ws: string[];
    modWs: string[];
  },
  /** The rules the app's holders set, and who built it. */
  toolRules: 'admin' as 'admin' | 'team',
  authorLevel: 'admin' as 'admin' | 'team',
  /** Who the owner route answers: an Admin user or a member. */
  login: 'admin' as 'admin' | 'member',
  /** The next handler or fetch throws a database error. */
  dbErr: false,
  /** The next call checks the real preconditions (fix round 1). */
  realPre: false,
  /** What one case recorded. */
  audit: [] as Array<[string, unknown]>,
  touches: [] as unknown[],
  /** Outside the snapshot: the gate caller each run was bound to. */
  gated: [] as Array<string | null>,
  viewers: [] as unknown[],
}));

// The scope and Admin view without a database (the gate's and dispatch's
// reads): a scope holds Admin when Admin is one of its workspaces, with
// every area.
vi.mock('../../../packages/db/src/viewer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/db/src/viewer')>();
  return {
    ...real,
    currentWorkspaceScope: () => h.scope,
  };
});
vi.mock('../../../packages/db/src/gateway/scope-answers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../packages/db/src/gateway/scope-answers')>()),
  scopeHoldsAdmin: async () => !!h.scope?.ws.includes(ADMIN_WS),
  adminOrSystemScope: async () => !h.scope || h.scope.ws.includes(ADMIN_WS),
  scopeHasArea: async (a: string) => !!h.scope?.ws.includes(ADMIN_WS) && AREAS.includes(a),
  loginHasArea: async (_l: string, a: string) => AREAS.includes(a),
}));
vi.mock('../../../packages/db/src/item-rights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../packages/db/src/item-rights')>()),
  itemWriteRefusal: async (ids: string[], need: string) =>
    ids.includes(REFUSED_ID) ? `item refused (${need})` : null,
  itemWriteRefusalOf: async (ids: string[], need: string) =>
    ids.includes(REFUSED_ID) ? { message: `item refused (${need})`, detail: 'no_edit' } : null,
}));
vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  // Every query of the tool groups answers the connector's group: the
  // member-app rule's system-wide group, and dispatch's connector binding.
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => [
      {
        slug: 'conn',
        ownerId: ANCHOR,
        enabled: true,
        integration: { mcp: { url: 'https://mcp.example.test' } },
        configuredBy: null,
      },
    ],
  };
  // The reads by their definers (A6b), answered from the same rows: the
  // connector's state from the group row; an app's holders as the group
  // row answered them on main (none).
  const execute = async (stmt: { queryChunks?: unknown[] }) => {
    const text = JSON.stringify(stmt.queryChunks ?? []);
    if (text.includes('mantle_connector_state')) return [{ slug: 'conn', usable: true }];
    if (text.includes('mantle_app_holders')) return [{ holders: null }];
    throw new Error(`unexpected statement in the parity mock: ${text.slice(0, 200)}`);
  };
  /** The scope withViewer enters, and the actor it binds (scopeActor). */
  const viewerScope = (actsFor: Record<string, unknown>) => {
    if ('link' in actsFor) return { kind: 'link', loginId: null, ws: [], modWs: [] };
    const login = String(actsFor.login).toLowerCase();
    // An app run reads through the app: its holders beyond Admin met with
    // the runner's workspaces (here Team).
    return { kind: 'user', loginId: login, ws: [TEAM_WS], modWs: [] };
  };
  return {
    ...real,
    db: { ...chain, execute },
    withViewer: async (actsFor: Record<string, unknown>, fn: () => Promise<unknown>) => {
      h.viewers.push(actsFor);
      const prev = h.scope;
      const next = viewerScope(actsFor);
      const outer = real.currentActor();
      const actor =
        next.kind === 'link'
          ? outer?.kind === 'contact' || outer?.kind === 'link'
            ? outer
            : ({ kind: 'link' } as const)
          : outer?.kind === 'login' && outer.loginId === next.loginId
            ? outer
            : real.loginActor(next.loginId!, 'rw');
      h.scope = next;
      try {
        return await real.runAsActor(actor, fn);
      } finally {
        h.scope = prev;
      }
    },
    // The system pool: no workspace scope inside.
    asSystem: (fn: () => Promise<unknown>, reason: Parameters<typeof real.asSystem>[1]) =>
      real.asSystem(async () => {
        const prev = h.scope;
        h.scope = null;
        try {
          return await fn();
        } finally {
          h.scope = prev;
        }
      }, reason),
  };
});
vi.mock('@mantle/api-keys', () => ({ getApiKey: async () => null }));

const TOOLS = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));
vi.mock('../../../packages/tools/src/resolve', () => ({
  resolveTool: async (_o: string, slug: string) => TOOLS.rows.get(slug) ?? null,
  resolveTools: async () => [],
}));
vi.mock('../../../packages/tools/src/preconditions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/tools/src/preconditions')>();
  return {
    ...real,
    // Stood in (null: none fails) but for the one case that checks the
    // real ones (fix round 1): their words, and their place before the
    // item rights.
    checkToolPreconditions: (...args: Parameters<typeof real.checkToolPreconditions>) =>
      h.realPre ? real.checkToolPreconditions(...args) : Promise.resolve(null),
  };
});
vi.mock('../../../packages/tools/src/external-access', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/tools/src/external-access')>();
  return {
    ...real,
    // The connector's workspaces: Admin with Write on, Team with it off.
    connectorResources: async (_o: string, _g: string, ws: string[]) =>
      [
        { workspaceId: ADMIN_WS, write: true },
        { workspaceId: TEAM_WS, write: false },
      ].filter((r) => ws.includes(r.workspaceId)),
    loginConnectorRefused: async (_o: string, _l: string, _g: string, write: boolean) =>
      write ? 'login connector refused (write)' : null,
    // A member's run of an outside tool (its database reads stood in): a
    // connector's tool by its mark, an http tool by External access.
    outsideToolVerdict: async (_o: string, tool: { handler: { kind: string } }, slug: string) => {
      const row = tool as unknown as Parameters<typeof real.connectorToolPolicy>[0];
      if (tool.handler.kind === 'mcp') {
        const policy = real.connectorToolPolicy(row);
        return { ok: true, tool, write: policy.effect === 'write' };
      }
      if (tool.handler.kind === 'http' && real.externalAccessActive(row)) {
        return { ok: true, tool, write: false };
      }
      return { ok: false, status: 403, reason: `outside tool '${slug}' refused` };
    },
  };
});
vi.mock('../../../packages/tools/src/mcp-client', () => ({
  mcpCallRemoteTool: async (
    _o: string,
    group: string,
    _m: unknown,
    tool: string,
    input: unknown,
  ) => {
    const db = await import('@mantle/db');
    const actor = db.currentActor();
    h.touches.push({
      remote: 'mcp',
      group,
      tool,
      input,
      actor: who(actor),
      mode: actor ? db.writeModeOf(actor) : null,
    });
    return { text: JSON.stringify({ group, tool }), isError: false, secrets: new Map() };
  },
}));
vi.mock('../../../packages/tools/src/safe-fetch', () => ({
  safeFetch: async (url: string) => {
    const db = await import('@mantle/db');
    const actor = db.currentActor();
    h.gated.push(db.currentCaller()?.via ?? null);
    h.touches.push({
      remote: 'http',
      url: String(url),
      actor: who(actor),
      mode: actor ? db.writeModeOf(actor) : null,
    });
    if (h.dbErr) throw dbError();
    return new Response('{"fetched":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
}));
vi.mock('../../../packages/tools/src/registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/tools/src/registry')>();
  return {
    ...real,
    // Every handler is a recorder: what the broker and dispatch decided
    // around the call.
    getBuiltinHandler: (slug: string) =>
      real.getBuiltinHandler(slug)
        ? async (input: Record<string, unknown>) => {
            const db = await import('@mantle/db');
            const actor = db.currentActor();
            h.gated.push(db.currentCaller()?.via ?? null);
            h.touches.push({
              ran: slug,
              input,
              actor: who(actor),
              mode: actor ? db.writeModeOf(actor) : null,
              scope: h.scope
                ? { kind: h.scope.kind, loginId: h.scope.loginId, ws: h.scope.ws }
                : null,
              home: db.currentCreateHome(),
            });
            if (h.dbErr) throw dbError();
            if (input.__throw) throw new Error(`handler threw: ${slug}`);
            return { ok: true, output: { ran: slug } };
          }
        : null,
  };
});

/** Who an actor is (its kind and id or reason), its write mode apart. */
function who(actor: unknown): unknown {
  if (!actor || typeof actor !== 'object') return null;
  const { mode: _mode, canWrite: _canWrite, ...rest } = actor as Record<string, unknown>;
  return rest;
}

/** A database error, as the pool throws one (a SQL text and its cause). */
function dbError(): Error {
  return Object.assign(new Error(SQL), {
    cause: Object.assign(new Error('relation "nodes" is locked'), {
      code: '55P03',
      severity: 'ERROR',
    }),
  });
}

// The routes' own lookups.
vi.mock('@/lib/auth', async (importOriginal) => {
  const { loginStandIn } = await import('@/server/run-route-stand-ins');
  const user = {
    id: ANCHOR,
    email: 'jo@example.invalid',
    actor: { id: ACTOR, email: 'jo@example.invalid', displayName: 'Jo', isOwner: true },
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    ownerCaller: () => user,
    // The owner row's Login (plan v3.2 section 2.2): an Admin user, or a member.
    ownerLoginCaller: () =>
      h.login === 'admin'
        ? loginStandIn({
            loginId: ACTOR,
            brainId: ANCHOR,
            email: user.email,
            displayName: 'Jo',
            actor: user.actor,
            admin: true,
          })
        : loginStandIn({
            loginId: MEMBER,
            brainId: ANCHOR,
            email: 'pat@example.invalid',
            displayName: 'Pat',
          }),
  };
});
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfterSec: 0 }),
  clientIpKey: () => 'ip',
}));

const SHARE = {
  id: 'share-2',
  ownerId: ANCHOR,
  nodeId: APP,
  nodeType: 'app',
  contactId: 'contact-7',
  canWrite: true,
  settings: { served: ['page-9'] },
};
vi.mock('@/lib/contact-share-gate', () => ({
  gateShare: async () => ({ kind: 'ok', share: SHARE }),
  contactCodeRequired: () => new Response('code', { status: 401 }),
}));
vi.mock('@/lib/shares', () => ({
  liveServedIds: async (s: { nodeId: string; settings?: { served?: string[] } }) =>
    new Set([s.nodeId, ...(s.settings?.served ?? [])]),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppRuntime: async (_owner: string, id: string) =>
    id === APP
      ? {
          id: APP,
          toolRules: h.toolRules,
          authorLevel: h.authorLevel,
          manifest: { toolSlugs: DECLARED },
          publishedBuild: { ok: true },
        }
      : null,
  getMemberRunnableApp: async (_anchor: string, id: string) =>
    id === APP
      ? {
          id: APP,
          title: 'Polls',
          writable: true,
          manifest: { toolSlugs: DECLARED },
          publishedBuild: { ok: true },
          dataReadOnly: false,
        }
      : null,
  recordAppAccess: (e: unknown) => h.audit.push(['app-access', e]),
  recordShareAccess: (e: unknown) => h.audit.push(['share-access', e]),
  recordAppError: (e: unknown) => h.audit.push(['app-error', e]),
}));

import type { Actor, Tool } from '@mantle/db';
import { loginActor, runAsActor } from '@mantle/db';
import { externalAccessToolSig } from '@mantle/tools';

// adminFacts answers what the stood-in Login (loginStandIn) says of it.
vi.mock('@/lib/auth/login', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminFacts: vi.fn((await import('@/server/run-route-stand-ins')).adminFactsStandIn),
}));

function builtinRow(slug: string): Tool {
  return {
    id: `id-${slug}`,
    slug,
    ownerId: ANCHOR,
    name: slug,
    description: '',
    handler: { kind: 'builtin', ref: slug },
    requiresConfirm: false,
    enabled: true,
    inputSchema: { type: 'object', properties: {} },
    externalAccess: null,
    createdBy: null,
  } as unknown as Tool;
}

function outsideRow(slug: string, handler: Record<string, unknown>, marked: boolean): Tool {
  const row = {
    id: `id-${slug}`,
    slug,
    ownerId: ANCHOR,
    name: slug,
    description: 'An outside tool.',
    handler,
    requiresConfirm: false,
    enabled: true,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    externalAccess: null as unknown,
    createdBy: null,
  };
  if (marked) {
    row.externalAccess = {
      handlerSig: externalAccessToolSig(row as unknown as Tool),
      confirmedReadOnlyAt: '2026-10-01T00:00:00.000Z',
      by: 'web',
    };
  }
  return row as unknown as Tool;
}

const ROWS: Tool[] = [
  ...[
    'note_list',
    'note_create',
    'page_update',
    'page_list',
    'tree_folders',
    'brain_capacity',
    'model_pool_list',
  ].map(builtinRow),
  {
    ...builtinRow('shell_echo'),
    handler: { kind: 'shell', cmd: 'echo parity' },
  } as unknown as Tool,
  outsideRow('mcp_conn_do', { kind: 'mcp', group: 'conn', toolName: 'do' }, false),
  outsideRow('mcp_conn_read', { kind: 'mcp', group: 'conn', toolName: 'read' }, true),
  outsideRow('api_thing', { kind: 'http', method: 'GET', url: 'https://api.example.test/x' }, true),
];
for (const r of ROWS) TOOLS.rows.set(r.slug, r);

/** What the app declares: every tool here but page_list. */
const DECLARED = [...ROWS.map((r) => r.slug).filter((s) => s !== 'page_list'), 'no_such_tool'];

type ToolCase = {
  name: string;
  slug: string;
  input?: Record<string, unknown>;
  dbErr?: boolean;
  /** Check the real preconditions (checkToolPreconditions), not none. */
  realPre?: boolean;
};

const CASES: readonly ToolCase[] = [
  { name: 'a read', slug: 'note_list' },
  { name: 'a write', slug: 'note_create', input: { title: 'x' } },
  { name: 'an item write it may make', slug: 'page_update', input: { id: ITEM_ID } },
  { name: 'an item write it may not make', slug: 'page_update', input: { id: REFUSED_ID } },
  { name: 'a missing tool', slug: 'no_such_tool' },
  { name: 'an owner-only tool', slug: 'tree_folders' },
  { name: 'an Admin-area read', slug: 'brain_capacity' },
  { name: 'an Admin-area tool, whole on the system pool', slug: 'model_pool_list' },
  { name: 'a shell tool', slug: 'shell_echo' },
  { name: "a connector's write", slug: 'mcp_conn_do', input: { q: 'x' } },
  { name: "a connector's marked read", slug: 'mcp_conn_read', input: { q: 'x' } },
  { name: 'an http tool with External access', slug: 'api_thing' },
  { name: 'a tool the app does not declare', slug: 'page_list' },
  { name: 'a handler that throws', slug: 'note_list', input: { __throw: true } },
  { name: 'a database error in a read', slug: 'note_list', dbErr: true },
  { name: 'a database error in an http tool', slug: 'api_thing', dbErr: true },
  // Fix round 1: the real preconditions, so their words and order are
  // compared. The id names an item the caller may not change, and the body
  // a reference that is no id: the id's precondition answers first (the
  // stubbed database finds no page), before the body's and the item
  // rights, as dispatch asked them before step 3b.
  {
    name: 'a precondition refusal (the real preconditions)',
    slug: 'page_update',
    input: { id: REFUSED_ID, markdown: '![x](media:2153d1f2)' },
    realPre: true,
  },
];

type Entry =
  | 'shared link (contact)'
  | 'member app'
  | 'owner app, Admin only (admin rules)'
  | 'owner app, another workspace holds it (team rules)'
  | 'dev console';

const ENTRIES: readonly Entry[] = [
  'shared link (contact)',
  'member app',
  'owner app, Admin only (admin rules)',
  'owner app, another workspace holds it (team rules)',
  'dev console',
];

type Route = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
let shareBroker: Route;
let appBroker: Route;
let devConsole: (req: Request) => Promise<Response>;

beforeAll(async () => {
  process.env.SESSION_SECRET ??= 'x'.repeat(48);
  shareBroker = (await import('@/app/s/[token]/tool-broker/route')).POST as unknown as Route;
  appBroker = (await import('@/app/api/apps/[id]/tool-broker/route')).POST as unknown as Route;
  devConsole = (await import('@/app/api/dev-tools/execute-tool/route')).POST;
}, 60_000);

const post = (body: unknown) =>
  new Request('http://x/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** The request scope an owner route's session guard enters. */
const adminRequestScope = () => ({
  kind: 'user',
  loginId: ACTOR,
  ws: [ADMIN_WS, TEAM_WS],
  modWs: [ADMIN_WS],
});

/** One call of one entry, recorded. */
async function call(entry: Entry, c: ToolCase): Promise<unknown> {
  h.audit = [];
  h.touches = [];
  h.gated = [];
  h.viewers = [];
  h.dbErr = c.dbErr === true;
  h.realPre = c.realPre === true;
  h.login = 'admin';
  h.toolRules = 'admin';
  h.authorLevel = 'admin';
  const body = { slug: c.slug, input: c.input ?? {} };
  let actor: Actor;
  let run: () => Promise<Response>;
  switch (entry) {
    case 'shared link (contact)':
      h.scope = null;
      actor = { kind: 'contact', canWrite: true };
      run = () => shareBroker(post(body), { params: Promise.resolve({ token: 'contact' }) });
      break;
    case 'member app':
      h.login = 'member';
      h.toolRules = 'team';
      h.scope = { kind: 'user', loginId: MEMBER, ws: [TEAM_WS], modWs: [] };
      actor = loginActor(MEMBER, 'rw');
      run = () => appBroker(post(body), { params: Promise.resolve({ id: APP }) });
      break;
    case 'owner app, Admin only (admin rules)':
      h.scope = adminRequestScope();
      actor = loginActor(ACTOR, 'rw');
      run = () => appBroker(post(body), { params: Promise.resolve({ id: APP }) });
      break;
    case 'owner app, another workspace holds it (team rules)':
      h.toolRules = 'team';
      h.scope = adminRequestScope();
      actor = loginActor(ACTOR, 'rw');
      run = () => appBroker(post(body), { params: Promise.resolve({ id: APP }) });
      break;
    case 'dev console':
      h.scope = adminRequestScope();
      actor = loginActor(ACTOR, 'rw');
      run = () => devConsole(post(body));
      break;
  }
  let status: number | string;
  let reply: unknown;
  try {
    const res = await runAsActor(actor, run);
    status = res.status;
    reply = await res.json();
  } catch (err) {
    status = 'threw';
    reply = (err as Error).message;
  }
  // The dev console's timing is no decision of the route.
  if (reply && typeof reply === 'object' && 'durationMs' in reply) {
    reply = { ...(reply as object), durationMs: 0 };
  }
  h.dbErr = false;
  h.realPre = false;
  return { status, body: reply, audit: h.audit, touches: h.touches, viewers: h.viewers };
}

describe('app broker parity (A5 step 3b)', () => {
  it('every entry, every tool: the same answer, audit and touches', async () => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const entry of ENTRIES) {
      out[entry] = {};
      for (const c of CASES) out[entry][c.name] = await call(entry, c);
    }
    await expect(JSON.stringify(out, null, 1) + '\n').toMatchFileSnapshot(
      './__snapshots__/app-broker-parity.json',
    );
  }, 120_000);

  it('is not vacuous: runs, refusals, masking and remote calls all occur', async () => {
    const read = JSON.stringify(await call('member app', CASES[0]!));
    expect(read).toContain('"ran":"note_list"');
    const missing = (await call('member app', CASES[4]!)) as { status: number };
    expect(missing.status).toBe(404);
    const write = (await call('member app', CASES[1]!)) as { status: number };
    expect(write.status).toBe(403);
    const area = JSON.stringify(await call('member app', CASES[6]!));
    expect(area).toContain('Admin workspace');
    const masked = JSON.stringify(await call('member app', CASES[14]!));
    expect(masked).not.toContain('Failed query');
    const raw = JSON.stringify(await call('dev console', CASES[14]!));
    expect(raw).toContain('Failed query');
    // page_update's item pre-check went (the pre-check removal: the
    // database refuses its write on the write role; the dev console and an
    // owner app at admin rules run as the owner on the system pool, where
    // no workspace scope is active, so on a box the pre-check never asked
    // there): the stubbed refusal is not reached now.
    const item = JSON.stringify(await call('dev console', CASES[3]!));
    expect(item).toContain('"ran":"page_update"');
    const remote = JSON.stringify(await call('shared link (contact)', CASES[11]!));
    expect(remote).toContain('"remote":"http"');
    const conn = JSON.stringify(await call('member app', CASES[10]!));
    expect(conn).toContain('"remote":"mcp"');
    // The real preconditions ran, before the item rights (fix round 1).
    const pre = JSON.stringify(
      await call(
        'dev console',
        CASES.find((c) => c.realPre)!,
      ),
    );
    expect(pre).toContain(`page ${REFUSED_ID} not found`);
    expect(pre).not.toContain('item refused');
    expect(pre).not.toContain('"ran":');
  });

  it('every run is bound to the gate, as its entry names it (A5 step 3b)', async () => {
    const expected: Record<Entry, string> = {
      'shared link (contact)': 'contact',
      'member app': 'app',
      'owner app, Admin only (admin rules)': 'app',
      'owner app, another workspace holds it (team rules)': 'app',
      'dev console': 'cookie',
    };
    for (const entry of ENTRIES) {
      let runs = 0;
      for (const c of CASES) {
        await call(entry, c);
        runs += h.gated.length;
        for (const via of h.gated) expect(via, `${entry}: ${c.name}`).toBe(expected[entry]);
      }
      expect(runs, entry).toBeGreaterThan(0);
    }
  });
});
