/**
 * The A8 surface cells (workspaces arch plan v2, section 12 A8): for each
 * way in (plan 4.3), a pairwise set of cells (role x kind x placement x
 * action) proves the surface gives the oracle's answer
 * (@mantle/db/matrix/guide-oracle, written from the guide alone). The
 * fixture is the SQL grid's (a8-grid.ts), seeded once; each write cell gets
 * a fresh item of its kind and placement, so no cell sees another's effect.
 *
 * Each entry runs the product's own path, real handlers, real gate:
 *
 *   web          HTTP through createApp (the gate, the route row, the session
 *                guard): GET and DELETE of the kind's item route, the grants
 *                panel's routes (add, remove, Write, move)
 *   api-v1       /api/v1 item reads with the login's read-write API key
 *   mcp-oauth    the one MCP surface for the login (prepareCallerTools,
 *                an OAuth connection)
 *   mcp-key      the same surface through /api/mcp's bearer lookup for the
 *                login's READ-ONLY key (resolveMcpCaller)
 *   peer         a linked brain with Acts as the login and Write on
 *                (resolveMcpCaller with its peer token)
 *   mcp-stdio    the stdio server (buildMantleMcpServer) as login(owner)
 *   web-turn     dispatchTool with the turn caller in the assistant's turn
 *                scope (withAgentScope, the role's own workspace)
 *   team-turn    the same, on the team surface (the logins outside Admin)
 *   telegram     the same, on the Telegram surface (the chat's login)
 *   run          a run item: the run caller in withRunScope
 *   recipe       a recipe tool whose one step is the action, in a turn
 *   heartbeat    the assistant of W with no user (assistant actor, its
 *                scope with no login), the turn caller
 *
 * A cell passes only on the right row effect (the probe of the SQL grid):
 * allowed is ok and the change made; refused is no change and a refusal
 * that is not a crash (a 5xx, a thrown error, a raw database error). A cell
 * whose oracle answer is not applicable is counted. Each cell's actor
 * misses are its own failure.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test:matrix
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ITEM_KINDS, ITEM_KIND_NAMES } from '@mantle/client-types/kinds';
import type {
  GuideAction,
  GuideActor,
  GuidePlacement,
  GuideRole,
  GuideSurface,
} from '@mantle/db/matrix/guide-oracle';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

type Reply = { isError?: boolean; content?: { text?: string }[] };
const text = (r: unknown) =>
  ((r as Reply | null)?.content ?? []).map((p) => p.text ?? '').join(' ');

/** What a way in answered. */
type Outcome = { ok: boolean; text: string; status?: number; thrown?: boolean };

/** A crash, never a deny: a 5xx, a throw, a raw database or runtime error
 *  in the reply (the mapper turns a refusal into words of its own). */
const GENERIC =
  /internal (server )?error|unexpected|TypeError|ReferenceError|cannot read prop|is not a function|syntax error|violates|duplicate key|does not exist|permission denied for|ECONN|THROWN/i;

/** The tools a kind's action goes through on a tool surface. */
const TOOL_EDIT: Readonly<Record<string, string>> = {
  note: 'note_update',
  task: 'task_update',
  event: 'event_update',
  formula: 'formula_update',
};
const TOOL_DELETE: Readonly<Record<string, string>> = {
  note: 'note_delete',
  task: 'task_delete',
  event: 'event_delete',
  formula: 'formula_delete',
  app: 'app_delete',
};
/** The /api/v1 item reads (D3: as the base route). */
const V1_READ: Readonly<Record<string, string>> = {
  note: '/api/v1/notes',
  task: '/api/v1/tasks',
  page: '/api/v1/pages',
  table: '/api/v1/tables',
  file: '/api/v1/files',
};

describe.skipIf(!DB_URL)('A8 surface cells: every way in gives the oracle’s answer', () => {
  type Ts = typeof import('@mantle/db/test-support');
  type Grid = typeof import('@mantle/db/matrix/a8-grid');
  type Oracle = typeof import('@mantle/db/matrix/guide-oracle');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let ls: typeof import('@mantle/mcp-core');
  let rt: typeof import('@mantle/runtime/agent');
  let tracing: typeof import('@mantle/tracing');
  let ex: typeof import('../../../packages/runtime/src/agent/tool-loop/execute-call');
  let g: Grid;
  let o: Oracle;
  let runRoute: typeof import('./run-route').runRoute;
  let fx: import('@mantle/db/matrix/a8-grid').A8Fixture;
  let dir = '';
  /** Each workspace's assistant. */
  const agentOf: Record<string, string> = {};
  /** Each login's read-write key (api-v1) and read-only key (mcp-key). */
  const keyRw: Partial<Record<GuideRole, string>> = {};
  const keyRo: Partial<Record<GuideRole, string>> = {};
  const peerToken: Partial<Record<GuideRole, string>> = {};

  const kinds = ITEM_KIND_NAMES.filter((k) => ITEM_KINDS[k].class === 'workspace');
  const rootOf = (kind: string): string => {
    if (kind === 'branch') return 'notes';
    const tree = (ITEM_KINDS as Record<string, { tree: { root: string } | null }>)[kind]!.tree;
    if (!tree) throw new Error(`no tree root for ${kind}`);
    return tree.root;
  };
  const contentRoute = (kind: string) =>
    (ITEM_KINDS as Record<string, { route: { content: string | null } }>)[kind]!.route.content;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a8-surfaces-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'a8-surface-cells-secret-at-least-32-characters';
    delete process.env.MANTLE_ADMIN_READS;
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the A8 surface cells', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    ls = await import('@mantle/mcp-core');
    rt = await import('@mantle/runtime/agent');
    tracing = await import('@mantle/tracing');
    ex = await import('../../../packages/runtime/src/agent/tool-loop/execute-call');
    g = await import('@mantle/db/matrix/a8-grid');
    o = await import('@mantle/db/matrix/guide-oracle');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    fx = await g.buildA8Fixture(raw, kinds, rootOf);
    await g.installProbe(raw);
    // The box in warn, as dev runs: a scoped login write goes to the write
    // role, and a refusal its checks stage is a miss the cell sees.
    await raw`select mantle_set_actor_check('warn')`;
    await m.asSystem(() => t.seedBuiltinTools(fx.owner), 'test');
    // One assistant per workspace ("Assistants and chats").
    for (const [name, wsId] of Object.entries(fx.ws)) {
      const id = randomUUID();
      agentOf[wsId] = id;
      await raw`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
        values (${id}, ${fx.owner}, ${`${fx.tag}-${name}`}, ${name}, 'fake/model', 'p',
                ${name === 'admin' ? 'assistant' : 'responder'}, ${wsId})`;
    }
    const keys = await import('../lib/access-keys');
    const { hashToken } = await import('@mantle/content/peers-crypto');
    for (const role of o.GUIDE_ROLES) {
      const login = fx.logins[role];
      for (const [access, into] of [
        ['read_write', keyRw],
        ['read', keyRo],
      ] as const) {
        const minted = await m.asSystem(
          () =>
            keys.mintAccessKey({
              name: `${fx.tag} ${role} ${access}`,
              loginId: login,
              access,
              areas: null,
              riskyTools: [],
              expiresAt: new Date(Date.now() + 30 * 86_400_000),
              createdBy: login,
              maxLive: 50,
            }),
          'test',
        );
        into[role] = minted!.key;
      }
      const token = `mtlpeer_${randomUUID().replace(/-/g, '')}`;
      const peerNode = randomUUID();
      await raw`insert into nodes (id, owner_id, type, title, path)
        values (${peerNode}, ${fx.owner}, 'mantle_peer', ${`${fx.tag} peer ${role}`}, 'peers')`;
      await raw`insert into mantle_peers
          (id, owner_id, node_id, display_name, base_url, inbound_token_hash, status, enabled,
           acts_as_login_id, write_enabled)
        values (${randomUUID()}, ${fx.owner}, ${peerNode}, ${`${fx.tag} peer ${role}`},
                ${`https://${role.toLowerCase()}.peer.example.invalid`}, ${hashToken(token)},
                'active', true, ${login}, true)`;
      peerToken[role] = token;
    }
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    const bridge = (globalThis as { __mantleRealtime?: { stop?: (() => Promise<void>) | null } })
      .__mantleRealtime;
    await bridge?.stop?.();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // ── the ways in ─────────────────────────────────────────────────────────

  const toolRows = new Map<string, Awaited<ReturnType<typeof t.resolveTool>>>();
  const toolRow = async (slug: string) => {
    if (!toolRows.has(slug)) {
      toolRows.set(slug, await m.asSystem(() => t.resolveTool(fx.owner, slug), 'test'));
    }
    const row = toolRows.get(slug);
    if (!row) throw new Error(`no tool ${slug}`);
    return row;
  };

  const loginActor = (role: GuideRole) =>
    m.loginActor(fx.logins[role], role === 'owner' ? 'owner' : 'rw');
  const isAdminUser = (role: GuideRole) => role === 'owner' || role === 'admin';
  const turnWs = (role: GuideRole) => {
    const w = o.TURN_WORKSPACE[role];
    return w === 'private' ? fx.privateWs[role]! : fx.ws[w];
  };

  const fromTool = (res: { ok: boolean; error?: unknown; output?: unknown }): Outcome => ({
    ok: res.ok,
    text: res.ok ? JSON.stringify(res.output ?? '') : String(res.error ?? ''),
  });
  const guard = async (fn: () => Promise<Outcome>): Promise<Outcome> => {
    try {
      return await fn();
    } catch (err) {
      return { ok: false, thrown: true, text: `THROWN ${(err as Error).message}` };
    }
  };

  /** The tool call of a kind's action on a tool surface, or null. */
  const toolCall = (kind: string, action: GuideAction, id: string) => {
    if (action === 'read') return { slug: 'node_read', input: { node_id: id } };
    if (action === 'edit' && TOOL_EDIT[kind]) {
      return { slug: TOOL_EDIT[kind]!, input: { id, title: `${fx.tag} edited` } };
    }
    if (action === 'delete' && TOOL_DELETE[kind]) {
      return { slug: TOOL_DELETE[kind]!, input: { id } };
    }
    return null;
  };

  /** An assistant turn's tool call, as the turn's tool loop dispatches it. */
  const inTurn =
    (surface: (role: GuideRole) => unknown, caller: () => unknown, recipe = false) =>
    async (role: GuideRole | null, slug: string, input: Record<string, unknown>) =>
      guard(async () => {
        const r = role!;
        const ws = turnWs(r);
        const tool = recipe
          ? ({
              slug: `${fx.tag}_recipe`,
              handler: { kind: 'recipe', steps: [{ tool: slug, input }] },
              inputSchema: { type: 'object', properties: {} },
            } as never)
          : await toolRow(slug);
        const res = await m.runAsActor(loginActor(r), () =>
          rt.withAgentScope(
            { id: agentOf[ws], ownerId: fx.owner, workspaceId: ws },
            () =>
              t.dispatchTool(tool, recipe ? {} : input, {
                ownerId: fx.owner,
                surface: surface(r) as never,
                caller: caller() as never,
              }),
            { loginId: fx.logins[r] },
          ),
        );
        return fromTool(res);
      });

  /** An MCP client on the one surface for `caller`; a call's outcome. */
  const mcpCall = async (
    caller: import('@mantle/mcp-core').McpCaller | null,
    as: ReturnType<typeof m.loginActor>,
    slug: string,
    input: Record<string, unknown>,
  ): Promise<Outcome> =>
    guard(async () => {
      const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
      const { Client } = await import('@modelcontextprotocol/client');
      let server: InstanceType<typeof McpServer>;
      if (!caller) {
        server = ls.buildMantleMcpServer(fx.owner) as never;
      } else {
        server = new McpServer({ name: 'a8', version: '0' });
        ls.registerPreparedTools(server, await ls.prepareCallerTools(caller));
      }
      const [a, b] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: fx.tag, version: '0' });
      await Promise.all([server.connect(a), c.connect(b)]);
      try {
        try {
          const r = (await m.runAsActor(as, () =>
            c.callTool({ name: slug, arguments: input }),
          )) as Reply;
          return { ok: !(r.isError ?? false), text: text(r) };
        } catch (err) {
          // A tool the caller may not call is not listed, and a direct call
          // is refused ("MCP, API keys and linked brains"): the protocol's
          // own refusal, not a crash.
          const msg = (err as Error).message;
          if (/Tool \S+ not found/.test(msg)) return { ok: false, text: `not listed: ${msg}` };
          throw err;
        }
      } finally {
        await c.close();
      }
    });

  const bearer = async (token: string) => {
    const auth = await import('../lib/mcp-auth');
    const caller = await auth.resolveMcpCaller(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    if (!caller) throw new Error('the bearer resolved no caller');
    return caller;
  };

  const http = async (
    role: GuideRole,
    method: string,
    p: string,
    body?: unknown,
    key?: string,
  ): Promise<Outcome> =>
    guard(async () => {
      const res = await runRoute(key ? { key } : fx.logins[role], method, p, body, {
        headers: {
          'x-forwarded-for': `10.${Math.floor(Math.random() * 250)}.0.${Math.floor(Math.random() * 250)}`,
        },
      });
      const out = await res.text();
      return { ok: res.status < 300, status: res.status, text: out.slice(0, 400) };
    });

  type Entry = {
    surface: GuideSurface;
    actor: GuideActor;
    roles: (GuideRole | null)[];
    supports: (kind: string, action: GuideAction) => boolean;
    run: (
      role: GuideRole | null,
      kind: string,
      action: GuideAction,
      id: string,
    ) => Promise<Outcome>;
  };

  /** The tool rows the brain resolves (read at the cells' start). */
  const resolvable = new Set<string>();
  const MCP_SURFACES = new Set<GuideSurface>(['mcp-oauth', 'mcp-key', 'peer', 'mcp-stdio']);
  const toolEntry = (
    surface: GuideSurface,
    actor: GuideActor,
    roles: (GuideRole | null)[],
    call: (
      role: GuideRole | null,
      slug: string,
      input: Record<string, unknown>,
    ) => Promise<Outcome>,
  ): Entry => ({
    surface,
    actor,
    roles,
    supports: (kind, action) => {
      const tc = toolCall(kind, action, 'x');
      // An assistant, a run and a recipe call the brain's tool rows; the
      // MCP surface lists its own definitions.
      return tc !== null && (MCP_SURFACES.has(surface) || resolvable.has(tc.slug));
    },
    run: (role, kind, action, id) => {
      const tc = toolCall(kind, action, id)!;
      return call(role, tc.slug, tc.input);
    },
  });

  const ALL: GuideRole[] = [
    'owner',
    'admin',
    'homeModerator',
    'writeGrant',
    'readGrant',
    'outsider',
  ];
  const MEMBERS: GuideRole[] = ['homeModerator', 'writeGrant', 'readGrant', 'outsider'];
  const WEB_READ_KINDS = new Set<string>(
    kinds.filter((k) => k !== 'branch' && contentRoute(k) !== null),
  );

  const entries = (): Entry[] => [
    {
      surface: 'web',
      actor: 'login',
      roles: ALL,
      supports: (kind, action) =>
        (['read', 'delete'].includes(action) && WEB_READ_KINDS.has(kind)) ||
        ['grantAdd', 'grantRemove', 'writeSwitch', 'move'].includes(action),
      run: async (role, kind, action, id) => {
        const r = role!;
        const R = fx.ws.R;
        switch (action) {
          case 'read':
            return http(r, 'GET', `${contentRoute(kind)}/${id}`);
          case 'delete':
            return http(r, 'DELETE', `${contentRoute(kind)}/${id}`);
          case 'grantAdd':
            return http(r, 'POST', `/api/grants/${id}`, {
              wsId: fx.ws.T,
              write: false,
              confirm: true,
            });
          case 'grantRemove':
            return http(r, 'DELETE', `/api/grants/${id}/${R}?confirm=1`);
          case 'writeSwitch': {
            const [row] = await raw<{ via: string | null }[]>`
              select via_folder_id::text as via from item_grants
               where node_id = ${id} and workspace_id = ${R}`;
            if (row?.via) {
              const h = await http(r, 'POST', `/api/grants/${id}/${R}/hand`);
              if (!h.ok) return h;
            }
            return http(r, 'PATCH', `/api/grants/${id}/${R}`, { write: true, confirm: true });
          }
          case 'move': {
            // A batch: 200 with each item moved or failed (moveItems).
            const res = await http(r, 'POST', '/api/grants/move', {
              nodeIds: [id],
              toWorkspaceId: fx.ws.T,
              confirm: true,
            });
            if (!res.ok) return res;
            const body = JSON.parse(res.text) as { moved?: number };
            return { ...res, ok: (body.moved ?? 0) > 0 };
          }
          default:
            throw new Error(`web ${action}`);
        }
      },
    },
    {
      surface: 'api-v1',
      actor: 'login',
      roles: ALL,
      supports: (kind, action) => action === 'read' && V1_READ[kind] !== undefined,
      run: (role, kind, _action, id) =>
        http(role!, 'GET', `${V1_READ[kind]}/${id}`, undefined, keyRw[role!]),
    },
    toolEntry('mcp-oauth', 'login', ALL, (role, slug, input) =>
      mcpCall(
        {
          role: isAdminUser(role!) ? 'admin' : 'member',
          anchorId: fx.owner,
          loginId: fx.logins[role!],
          via: 'oauth',
          write: true,
          oauthClientId: 'a8',
        },
        loginActor(role!),
        slug,
        input,
      ),
    ),
    toolEntry('mcp-key', 'login-ro', ALL, async (role, slug, input) =>
      mcpCall(await bearer(keyRo[role!]!), loginActor(role!), slug, input),
    ),
    toolEntry('peer', 'login', ALL, async (role, slug, input) =>
      mcpCall(await bearer(peerToken[role!]!), loginActor(role!), slug, input),
    ),
    toolEntry('mcp-stdio', 'login', ['owner'], (_role, slug, input) =>
      mcpCall(null, m.loginActor(fx.owner, 'owner'), slug, input),
    ),
    toolEntry(
      'web-turn',
      'turn',
      ALL,
      inTurn(
        (r) => ({ kind: 'web', loginId: fx.logins[r] }),
        () => t.turnCaller(),
      ),
    ),
    toolEntry(
      'team-turn',
      'turn',
      MEMBERS,
      inTurn(
        (r) => ({ kind: 'team', loginId: fx.logins[r] }),
        () => t.turnCaller(),
      ),
    ),
    toolEntry(
      'telegram',
      'turn',
      ALL,
      inTurn(
        () => ({ kind: 'telegram' }),
        () => t.turnCaller(),
      ),
    ),
    toolEntry('run', 'turn', ALL, (role, slug, input) =>
      guard(async () => {
        const r = role!;
        const res = await m.runAsActor(loginActor(r), () =>
          rt.withRunScope(
            { workspaceId: turnWs(r), loginId: fx.logins[r], ownerId: fx.owner },
            async () =>
              t.dispatchTool(await toolRow(slug), input, {
                ownerId: fx.owner,
                caller: t.runCaller(),
              }),
          ),
        );
        return fromTool(res);
      }),
    ),
    toolEntry(
      'recipe',
      'turn',
      ALL,
      inTurn(
        (r) => ({ kind: 'web', loginId: fx.logins[r] }),
        () => t.turnCaller(),
        true,
      ),
    ),
    toolEntry('heartbeat', 'assistant', [null], (_role, slug, input) =>
      guard(async () => {
        const ws = fx.ws[o.ASSISTANT_WORKSPACE as 'W'];
        const res = await m.runAsActor({ kind: 'assistant', agentId: agentOf[ws]! }, () =>
          rt.withAgentScope({ id: agentOf[ws], ownerId: fx.owner, workspaceId: ws }, async () =>
            t.dispatchTool(await toolRow(slug), input, {
              ownerId: fx.owner,
              surface: { kind: 'web', loginId: null } as never,
              caller: t.turnCaller(),
            }),
          ),
        );
        return fromTool(res);
      }),
    ),
    toolEntry('pending', 'turn', ALL, (role, slug, input) =>
      guard(async () => {
        // A call that waits for approval (docs/actors.md, "A pending tool
        // call, approved"): queued in the role's assistant turn through the
        // tool loop's own queue path (executeToolCall, its tool row set to
        // requires_confirm for the call), then approved by the owner from
        // no scope (approvePendingCall). It runs as the call's login as it
        // is now, in the scope it was queued in.
        const r = role!;
        const ws = turnWs(r);
        const login = fx.logins[r];
        const row = await toolRow(slug);
        const pendingIds: string[] = [];
        await raw`update tools set requires_confirm = true
                   where owner_id = ${fx.owner} and slug = ${slug}`;
        let queued: { ok: boolean; output?: unknown; error?: unknown };
        try {
          queued = (await m.runAsActor(loginActor(r), () =>
            rt.withAgentScope(
              { id: agentOf[ws], ownerId: fx.owner, workspaceId: ws },
              () =>
                tracing.startTrace(
                  {
                    kind: 'responder_turn',
                    ownerId: fx.owner,
                    agentId: agentOf[ws]!,
                    loginId: login,
                  },
                  () =>
                    ex.executeToolCall({
                      args: {
                        ownerId: fx.owner,
                        agentId: agentOf[ws],
                        agentSlug: `${fx.tag}-pending`,
                        surface: { kind: isAdminUser(r) ? 'web' : 'team', loginId: login },
                      } as never,
                      slug,
                      call: {
                        id: `a8-${randomUUID()}`,
                        function: { name: slug, arguments: JSON.stringify(input) },
                      },
                      tool: { ...row, requiresConfirm: true } as never,
                      input,
                      argParseError: null,
                      argValidation: null,
                      argValidationMode: 'off',
                      lastUserMessage: undefined,
                      pendingIds,
                    }),
                ),
              { loginId: login },
            ),
          )) as typeof queued;
        } finally {
          await raw`update tools set requires_confirm = false
                     where owner_id = ${fx.owner} and slug = ${slug}`;
        }
        // Refused at queue time (the gate's queue-time check): never queued.
        if (pendingIds.length !== 1) return fromTool(queued as never);
        const done = await m.runAsActor(m.loginActor(fx.owner, 'owner'), () =>
          t.approvePendingCall(fx.owner, pendingIds[0]!, { approverLoginId: fx.owner }),
        );
        const [p] = await raw<{ status: string; error: string | null; result: unknown }[]>`
          select status, error, result from pending_tool_calls where id = ${pendingIds[0]!}`;
        const ok = p?.status === 'approved';
        return {
          ok: ok && !p?.error,
          text: `${p?.status ?? 'gone'} ${p?.error ?? ''} ${JSON.stringify(p?.result ?? done ?? '')}`.slice(
            0,
            2000,
          ),
        };
      }),
    ),
    {
      // An open public link: its view as JSON, through the gate's /s row
      // (the share gate judges the token). The kinds that may carry one.
      surface: 'share-link',
      actor: 'link',
      roles: [null],
      supports: (kind, action) =>
        action === 'read' &&
        // An app's link serves its frame (a published build, which the
        // fixture's app has none of).
        kind !== 'app' &&
        (ITEM_KINDS as Record<string, { publicLink: boolean | string }>)[kind]!.publicLink === true,
      run: (_role, _kind, _action, id) =>
        guard(async () => {
          const [s] = await raw<{ token: string }[]>`
            select token from shares where node_id = ${id} and revoked_at is null limit 1`;
          if (!s) return { ok: false, text: 'no open link' };
          const res = await runRoute(null, 'GET', `/s/${s.token}/view`, undefined, {
            headers: { 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.1` },
          });
          return {
            ok: res.status < 300,
            status: res.status,
            text: (await res.text()).slice(0, 4000),
          };
        }),
    },
  ];

  /** Judge one cell's outcome against the oracle and the row effect. */
  const judge = (
    cell: import('@mantle/db/matrix/a8-grid').A8Cell,
    want: { allow: true } | { allow: false; why: string },
    out: Outcome,
    before: string,
    after: string,
    item: { id: string; title: string },
  ): string | null => {
    const generic = out.thrown || (out.status ?? 0) >= 500 || (!out.ok && GENERIC.test(out.text));
    if (generic) return `a crash, not a deny: ${out.status ?? ''} ${out.text.slice(0, 160)}`;
    if (cell.action === 'read') {
      const seen = out.ok && (out.text.includes(item.id) || out.text.includes(item.title));
      if (want.allow && !seen)
        return `not read, the oracle allows: ${out.status ?? ''} ${out.text.slice(0, 160)}`;
      if (!want.allow && out.ok) return `read, the oracle denies: ${out.text.slice(0, 100)}`;
      return null;
    }
    const changed = after !== before;
    if (!want.allow) {
      if (changed)
        return `changed, the oracle denies (${out.status ?? ''} ${out.text.slice(0, 100)})`;
      if (out.ok) return `answered ok and changed nothing, the oracle denies`;
      return null;
    }
    if (!out.ok) return `refused, the oracle allows: ${out.status ?? ''} ${out.text.slice(0, 160)}`;
    if (!changed) return 'answered ok, no row changed';
    return g.effectMade(fx, cell, want, after);
  };

  it('each way in: a pairwise set of cells, each the oracle’s answer', async () => {
    const started = Date.now();
    // The surface cells' names (a grid cell's name starts with its actor).
    const known = new Set(
      Object.keys((await import('@mantle/db/matrix/a8-known-failures')).KNOWN_FAILURES).filter(
        (n) => !n.split(' ')[0]!.includes('/'),
      ),
    );
    for (const slug of ['node_read', ...Object.values(TOOL_EDIT), ...Object.values(TOOL_DELETE)]) {
      if (await m.asSystem(() => t.resolveTool(fx.owner, slug), 'test')) resolvable.add(slug);
    }
    const failures = new Map<string, string>();
    const counts: string[] = [];
    let total = 0;
    for (const e of entries()) {
      const candidates: import('@mantle/db/matrix/a8-grid').A8Cell[] = [];
      let na = 0;
      for (const role of e.roles) {
        for (const kind of kinds) {
          for (const placement of o.GUIDE_PLACEMENTS) {
            for (const action of o.GUIDE_ACTIONS) {
              if (!e.supports(kind, action)) continue;
              const want = o.expectedAccess(
                { surface: e.surface, placement, actor: e.actor },
                role,
                kind,
                action,
              );
              if ('na' in want) na++;
              else candidates.push({ actor: e.actor, role, kind, placement, action });
            }
          }
        }
      }
      const cells = g.pairwise(candidates);
      let pass = 0;
      let allow = 0;
      for (const c of cells) {
        const want = o.expectedAccess(
          { surface: e.surface, placement: c.placement, actor: c.actor },
          c.role,
          c.kind,
          c.action,
        ) as { allow: true } | { allow: false; why: string };
        if (want.allow) allow++;
        const reads = ['read', 'list', 'search'].includes(c.action);
        const item = reads
          ? fx.items[c.kind]![c.placement as GuidePlacement]!
          : await g.makeA8Item(raw, fx, c.kind, c.placement);
        const probe = async () =>
          (await raw<{ p: string }[]>`select a8_probe(${item.id}::uuid) as p`)[0]!.p;
        const before = await probe();
        m.takeActorMisses();
        const out = await e.run(c.role, c.kind, c.action, item.id);
        const misses = m.takeActorMisses();
        const after = await probe();
        const name = `${e.surface} ${g.cellName(c)}`;
        const why =
          judge(c, want, out, before, after, item) ??
          (misses.length ? `actor miss: ${JSON.stringify(misses).slice(0, 160)}` : null);
        if (why) failures.set(name, why);
        else pass++;
      }
      total += cells.length;
      counts.push(
        `  ${e.surface}: ${cells.length} cells (${allow} allow) of ${candidates.length} candidates, ` +
          `${pass} pass, ${cells.length - pass} fail, ${na} not applicable`,
      );
    }
    const unexpected = [...failures].filter(([n]) => !known.has(n)).map(([n, r]) => `${n}: ${r}`);
    console.log(
      [
        `A8 surfaces: ${total} cells in ${((Date.now() - started) / 1000).toFixed(1)} s, ` +
          `${failures.size} fail (${failures.size - unexpected.length} known)`,
        ...counts,
        ...[...failures].map(([n, r]) => `  FAIL ${n}: ${r}`),
      ].join('\n'),
    );
    expect(unexpected, 'surface cells that fail and are not known failures').toEqual([]);
    const fixed = [...known].filter((n) => !failures.has(n));
    expect(fixed, 'known failures that pass now: take them off the list').toEqual([]);
  }, 900_000);
});
