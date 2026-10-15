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
 *   run          a run item through the product's own executor
 *                (executeRunItem, server/web/lib/runs/execute-item.ts): a
 *                run of the role's login and turn workspace, one tool_call
 *                item, run as the runs worker runs it
 *   recipe       a recipe tool whose one step is the action, in a turn
 *   heartbeat    the assistant of W with no user (assistant actor, its
 *                scope with no login), the turn caller, on the surface
 *                heartbeats/fire.ts gives a workspace assistant's fire
 *   admin-heartbeat  the Admin assistant with no user, which acts for the
 *                owner (login(owner), the Admin turn scope with no login
 *                asked), the turn caller, on the Admin assistant's surface
 *   pending      a call queued in a turn, approved by the owner
 *   share-link   an open public link's view (/s/<token>/view)
 *   contact-share  a contact share through the /s broker, with the
 *                contact's cookie: its view, and its app's data
 *                (/s/<token>/db-broker exec; the app's SQLite stood in, as
 *                contact-share-gate.db.test.ts does), with Can write on
 *                (contact-rw) and off (contact-ro); and two denies with
 *                Can write on: an Informational app's data, and the
 *                db-broker of a share that is no app (contact-share-deny)
 *
 * Every cell runs in each actor check mode (off, the fleet's default; warn;
 * on): the box's mode (mantle_set_actor_check) and the process's
 * (MANTLE_ACTOR_CHECK) set together, in that order (see CHECK_MODES below).
 *
 * A cell passes only on the right row effect (the probe of the SQL grid):
 * allowed is ok and the change made; refused is no change and a refusal
 * that is not a crash (a 5xx, a thrown error, a raw database or runtime
 * text: GENERIC). A refused write that changed the row says so first, crash
 * or not. The cells of a surface are picked in a stable order (a8-grid.ts
 * pairwise, salted with the surface's name), so a new kind or tool does not
 * reshuffle them. A cell whose oracle answer is not applicable is counted,
 * by reason, and the counts are pinned. Each cell's actor misses are its
 * own failure.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test:matrix
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ITEM_KINDS } from '@mantle/client-types/kinds';
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
// The app's own SQLite (the fixture's app has none): a statement the /s
// broker sends answers as if run; the brain's side of the write (the
// client-written stamp the probe reads) is the real one.
vi.mock('@mantle/content/app-broker', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appDbQuery: vi.fn(async () => ({ rows: [] })),
  appDbExec: vi.fn(async () => ({ changes: 1 })),
}));

type Reply = { isError?: boolean; content?: { text?: string }[] };
const text = (r: unknown) =>
  ((r as Reply | null)?.content ?? []).map((p) => p.text ?? '').join(' ');

/** What a way in answered. */
type Outcome = { ok: boolean; text: string; status?: number; thrown?: boolean };

/** A crash, never a deny: a 5xx, a throw, a raw database or runtime error
 *  in the reply (the mapper turns a refusal into words of its own). The raw
 *  texts: a JavaScript error, a driver or query builder's ("Failed query:
 *  update ..."), a Postgres message or SQLSTATE (a relation, a column, row
 *  security, 42501 and its kin), a guard of the runtime's own
 *  ("withSystemTx: only outside a viewer scope"), a stack frame. */
const GENERIC = new RegExp(
  [
    'internal (server )?error',
    'unexpected',
    'TypeError',
    'ReferenceError',
    'RangeError',
    'cannot read prop',
    'is not a function',
    'syntax error',
    'violates',
    'duplicate key',
    'does not exist',
    'permission denied for',
    'ECONN',
    'THROWN',
    // The query builder and the driver.
    'Failed query',
    'drizzle',
    'PostgresError',
    '\\bSQLSTATE\\b',
    // A Postgres error code: insufficient privilege, the integrity and
    // syntax classes, a deadlock, a lock timeout.
    '\\b(42501|42P01|42703|42883|23502|23503|23505|23514|40001|40P01|55P03|25P02)\\b',
    'current transaction is aborted',
    'invalid input syntax',
    'row-level security',
    '\\brelation "',
    '\\bcolumn "',
    // The runtime's own guards.
    'withSystemTx',
    'withScope:',
    'withTurnScope',
    'enterRequestScope',
    'only outside a viewer scope',
    // A stack frame.
    '\\n\\s*at \\S',
    '\\.(ts|js|mjs):\\d+:\\d+',
    'node_modules',
  ].join('|'),
  'i',
);

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

/** The surface a heartbeat's turn names (packages/runtime/src/heartbeats/
 *  fire.ts, the runToolLoop call in fireAs): a workspace assistant's fire
 *  is "not the owner's channel: a team surface with no login (read only,
 *  private reads off)"; the Admin assistant's is the owner's web surface
 *  (Telegram only when the heartbeat names a chat paired to the login it
 *  answers, which the fixture's do not). fire.ts builds it inline (no
 *  builder to import), so the source pin below fails if it changes. */
const HEARTBEAT_SURFACE = {
  workspace: { kind: 'team', privateReads: false },
  admin: { kind: 'web' },
} as const;

describe('A8 surface cells: the surfaces they send are the product’s', () => {
  it('a heartbeat fire names the surfaces HEARTBEAT_SURFACE sends', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = (
      await readFile(
        path.join(import.meta.dirname, '../../../packages/runtime/src/heartbeats/fire.ts'),
        'utf8',
      )
    ).replace(/\s+/g, ' ');
    expect(src).toContain(
      "surface: scoped && !adminAssistant ? { kind: 'team', privateReads: false } :",
    );
    expect(src).toContain(": { kind: 'web' }, }),");
  });
});

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
  let runs: typeof import('@mantle/runs');
  let runItem: typeof import('../lib/runs/execute-item');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let fx: import('@mantle/db/matrix/a8-grid').A8Fixture;
  let dir = '';
  /** Each workspace's assistant. */
  const agentOf: Record<string, string> = {};
  /** The contact the contact-share cells share with, and its cookie. */
  let contactId = '';
  let contactCookie = '';
  /** Each login's read-write key (api-v1) and read-only key (mcp-key). */
  const keyRw: Partial<Record<GuideRole, string>> = {};
  const keyRo: Partial<Record<GuideRole, string>> = {};
  const peerToken: Partial<Record<GuideRole, string>> = {};

  /** The fixture's kinds (a8-grid.ts A8_KINDS, read once it is imported). */
  let kinds: readonly string[] = [];
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
    runs = await import('@mantle/runs');
    runItem = await import('../lib/runs/execute-item');
    actorMode = await import('../../../packages/db/src/actor');
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    kinds = g.A8_KINDS;
    fx = await g.buildA8Fixture(raw);
    await g.installProbe(raw);
    // The box at off, the fleet's default, while the brain is set up; each
    // run of the cells sets its mode (CHECK_MODES, off to on).
    await raw`select mantle_set_actor_check('off')`;
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
    // One contact with sharing on, and its visitor cookie (the value the
    // code prompt sets: lib/contact-share-gate.ts).
    const content = await import('@mantle/content');
    const auth = await import('../lib/auth/tokens');
    contactId = randomUUID();
    await raw`insert into nodes (id, owner_id, type, title, path)
      values (${contactId}, ${fx.owner}, 'contact', ${`${fx.tag} contact`}, 'contacts')`;
    await m.asSystem(() => content.enableContactSharing(fx.owner, contactId), 'test');
    const [code] = await raw<{ epoch: number }[]>`
      select code_epoch as epoch from contact_share_codes where contact_id = ${contactId}`;
    const visitor = auth.buildContactVisitorValue({
      contactId,
      ownerId: fx.owner,
      codeEpoch: code!.epoch,
    });
    contactCookie = `${auth.CONTACT_VISITOR_COOKIE}=${visitor.value}`;
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    delete process.env.MANTLE_ACTOR_CHECK;
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
    /** The name its cells and counts go by, when not the surface's. */
    label?: string;
    actor: GuideActor;
    roles: (GuideRole | null)[];
    /** Whether the way in can do it; a string: it cannot, counted under
     *  that reason (no cell drops out uncounted). */
    supports: (kind: string, action: GuideAction) => boolean | string;
    /** A deny the guide gives this way in and the oracle cannot see (it
     *  knows no tools): the reason, else null. */
    narrow?: (kind: string, action: GuideAction) => string | null;
    /** Cells run besides the pairwise pick: a case a finding names. */
    always?: {
      role: GuideRole | null;
      kind: string;
      placement: GuidePlacement;
      action: GuideAction;
    }[];
    run: (
      role: GuideRole | null,
      kind: string,
      action: GuideAction,
      id: string,
    ) => Promise<Outcome>;
  };

  const MCP_SURFACES = new Set<GuideSurface>(['mcp-oauth', 'mcp-key', 'peer', 'mcp-stdio']);
  /** The builtins with no tool row (mcpOnly), those that wait for approval,
   *  and a peer's risky ones, read once the tools load. */
  const mcpOnly = new Set<string>();
  const confirmGated = new Set<string>();
  const peerRisky = new Set<string>();
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
    // Every slug resolves (the test asserts it first), so a cell drops out
    // only where the kind's action has no tool.
    // An assistant, a run and a recipe call the brain's tool rows, and an
    // MCP-only tool has none (the test pins which slugs resolve); the MCP
    // surface lists its own definitions.
    supports: (kind, action) => {
      const tc = toolCall(kind, action, 'x');
      if (!tc) return false;
      if (!MCP_SURFACES.has(surface) && mcpOnly.has(tc.slug)) {
        return `no tool row: ${tc.slug} is MCP only`;
      }
      return true;
    },
    // A deny the oracle cannot see (it knows no tools), each run as a cell.
    narrow: (kind, action) => {
      const tc = toolCall(kind, action, 'x');
      if (!tc) return null;
      // "Linked brains": a peer calls a risky tool only when its list
      // allows it; the fixture's peers allow none.
      if (surface === 'peer' && peerRisky.has(tc.slug)) {
        return `a peer may not call ${tc.slug}: a risky tool its list does not allow`;
      }
      // Approval, not access, for everyone (the owner too). A recipe step
      // calls no tool that waits for approval (packages/tools/src/dispatch.ts,
      // classifyRecipeStepTool: 'confirm'); a run item never runs one
      // headless (server/web/lib/runs/execute-item.ts, `tool.requiresConfirm`
      // before dispatch: "Confirm-gated tools never run headless"), the
      // phase waits on an ask_human step instead.
      if (surface === 'recipe' && confirmGated.has(tc.slug)) {
        return `a recipe step may not call ${tc.slug}: it waits for approval`;
      }
      if (surface === 'run' && confirmGated.has(tc.slug)) {
        return `a run item may not run ${tc.slug}: it waits for approval`;
      }
      return null;
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
  /** The owner's decision of 2026-10-15 (plan s32, F3 revised), run on the
   *  web and over MCP whatever the pick: each Admin user's delete of an app
   *  homed in Admin, allowed (to the trash). */
  const ADMIN_APP_DELETES = (['owner', 'admin'] as const).map((role) => ({
    role,
    kind: 'app',
    placement: 'admin' as const,
    action: 'delete' as const,
  }));
  const MEMBERS: GuideRole[] = ['homeModerator', 'writeGrant', 'readGrant', 'outsider'];
  /** A contact share of the item (Can write: `write`), made for the cell. */
  const contactShare = async (id: string, write: boolean): Promise<string> => {
    const content = await import('@mantle/content');
    const [made] = await m.asSystem(
      () => content.createContactShares(fx.owner, id, [contactId], write),
      'test',
    );
    return made!.path.slice('/s/'.length);
  };
  /** An app's published build (the /s broker serves only a built app);
   *  the bundle itself is never read. */
  const PUBLISHED = JSON.stringify({
    storageKey: 'apps/a8.js',
    sha256: 'a8',
    builtAt: '2026-10-01T00:00:00Z',
    esbuildVersion: '0',
    bytes: 1,
    ok: true,
  });
  /** A contact share through the /s broker, its cookie sent: the view
   *  (read), the app's data (appData: db-broker exec). */
  const contactEntry = (actor: 'contact-rw' | 'contact-ro', shareable: Set<string>): Entry => ({
    surface: 'contact-share',
    actor,
    roles: [null],
    supports: (kind, action) =>
      (action === 'read' &&
        kind !== 'app' &&
        shareable.has(kind) &&
        (ITEM_KINDS as Record<string, { publicLink: boolean | string }>)[kind]!.publicLink ===
          true) ||
      (action === 'appData' && kind === 'app'),
    run: (_role, kind, action, id) =>
      guard(async () => {
        if (kind === 'app') {
          await raw.begin(async (tx) => {
            await tx.unsafe(g.FIXTURE_ACTOR);
            await tx`update apps set manifest = '{}'::jsonb, published_build = ${PUBLISHED}::jsonb
                      where node_id = ${id}`;
          });
        }
        const token = await contactShare(id, actor === 'contact-rw' && kind === 'app');
        const headers = {
          cookie: contactCookie,
          'x-forwarded-for': `10.7.${Math.floor(Math.random() * 250)}.1`,
        };
        const res =
          action === 'read'
            ? await runRoute(null, 'GET', `/s/${token}/view`, undefined, { headers })
            : await runRoute(
                null,
                'POST',
                `/s/${token}/db-broker`,
                { op: 'exec', sql: 'insert into a8 (v) values (?)', params: [1] },
                { headers },
              );
        return {
          ok: res.status < 300,
          status: res.status,
          text: (await res.text()).slice(0, 4000),
        };
      }),
  });

  /** Two writes a contact share with Can write may not make, which the
   *  pairwise pick cannot reach: the oracle knows no Informational switch,
   *  and the contact-share entry sends app data to an app only. The app's
   *  data while the app is Informational ("Informational wins over a
   *  share's Can write", the /s db-broker, access matrix L23), and the
   *  db-broker of a contact share of `nonApp` (Can write is an app's only:
   *  createContactShares refuses it on another kind, so the share is the
   *  contact's read share, and the broker serves an app only). */
  const contactDenyEntry = (nonApp: string): Entry => ({
    surface: 'contact-share',
    label: 'contact-share-deny',
    actor: 'contact-rw',
    roles: [null],
    supports: () => false,
    always: [
      { role: null, kind: 'app', placement: 'root', action: 'appData' },
      { role: null, kind: nonApp, placement: 'root', action: 'appData' },
    ],
    narrow: (kind) =>
      kind === 'app'
        ? 'an Informational app’s data is read only, Can write or not'
        : `a share of a ${kind} has no app data: the /s broker serves an app only`,
    run: (_role, kind, _action, id) =>
      guard(async () => {
        if (kind === 'app') {
          await raw.begin(async (tx) => {
            await tx.unsafe(g.FIXTURE_ACTOR);
            await tx`update apps set manifest = '{}'::jsonb, published_build = ${PUBLISHED}::jsonb,
                            data_read_only = true
                      where node_id = ${id}`;
          });
        }
        const token = await contactShare(id, kind === 'app');
        const res = await runRoute(
          null,
          'POST',
          `/s/${token}/db-broker`,
          { op: 'exec', sql: 'insert into a8 (v) values (?)', params: [1] },
          {
            headers: {
              cookie: contactCookie,
              'x-forwarded-for': `10.8.${Math.floor(Math.random() * 250)}.1`,
            },
          },
        );
        return {
          ok: res.status < 300,
          status: res.status,
          text: (await res.text()).slice(0, 4000),
        };
      }),
  });

  const entries = async (): Promise<Entry[]> => {
    const WEB_READ_KINDS = new Set<string>(
      kinds.filter((k) => k !== 'branch' && contentRoute(k) !== null),
    );
    const { CONTACT_SHAREABLE_TYPES } = await import('@mantle/content');
    const shareable = new Set<string>(CONTACT_SHAREABLE_TYPES as readonly string[]);
    return [
      {
        surface: 'web',
        actor: 'login',
        roles: ALL,
        supports: (kind, action) =>
          (['read', 'delete'].includes(action) && WEB_READ_KINDS.has(kind)) ||
          ['grantAdd', 'grantRemove', 'writeSwitch', 'move'].includes(action),
        always: ADMIN_APP_DELETES,
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
      {
        ...toolEntry('mcp-oauth', 'login', ALL, (role, slug, input) =>
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
        always: ADMIN_APP_DELETES,
      },
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
          // The product's run path, whole: a run of the role's login (no
          // agent: the login's own MCP client planned it), stamped with the
          // role's turn workspace, its one tool_call item made ready and run
          // by executeRunItem as the runs worker runs it
          // (server/web/workers/runs.ts, under the worker's system actor).
          // The executor refuses a tool that waits for approval before
          // dispatch, runs the rest as the run's login as it is now, in
          // withRunScope, on the surface {kind:'owner', via:'run', loginId}.
          const r = role!;
          const ws = turnWs(r);
          const { runId } = await m.runAsSystem('worker:runs', () =>
            runs.createRun(m.db, {
              ownerId: fx.owner,
              title: `${fx.tag} run`,
              loginId: fx.logins[r],
              plan: {
                kind: 'seq',
                children: [{ kind: 'tool_call', payload: { tool: slug, args: input } }],
              } as never,
            }),
          );
          const [item] = await raw.begin(async (tx) => {
            await tx.unsafe(g.FIXTURE_ACTOR);
            await tx`update runs set workspace_id = ${ws} where id = ${runId}`;
            return tx<{ id: string }[]>`
              update run_items set state = 'ready', workspace_id = ${ws}
               where run_id = ${runId} and kind = 'tool_call' returning id::text as id`;
          });
          await m.runAsSystem('worker:runs', () => runItem.executeRunItem(item!.id));
          const [row] = await raw<
            {
              state: string;
              result: {
                output?: unknown;
                failure?: { type?: string; message?: string };
              } | null;
            }[]
          >`select state, result from run_items where id = ${item!.id}`;
          if (row?.state === 'done') {
            return { ok: true, text: JSON.stringify(row.result?.output ?? '') };
          }
          const f = row?.result?.failure;
          return {
            ok: false,
            text: `${row?.state ?? 'gone'} ${f?.type ?? ''}: ${f?.message ?? ''}`,
          };
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
                surface: HEARTBEAT_SURFACE.workspace as never,
                caller: t.turnCaller(),
              }),
            ),
          );
          return fromTool(res);
        }),
      ),
      // The Admin assistant with no user (a heartbeat, a run): "except the
      // Admin assistant, which acts for the owner" ("Assistants and chats").
      // Its fire runs as login(owner) (heartbeats/fire.ts, no answerer) in the
      // Admin turn scope with no login asked (withAgentScope: the owner's
      // seat): the owner's turn, to the oracle.
      toolEntry('admin-heartbeat', 'turn', ['owner'], (_role, slug, input) =>
        guard(async () => {
          const ws = fx.ws.admin;
          const res = await m.runAsActor(m.loginActor(fx.owner, 'owner'), () =>
            rt.withAgentScope({ id: agentOf[ws], ownerId: fx.owner, workspaceId: ws }, async () =>
              t.dispatchTool(await toolRow(slug), input, {
                ownerId: fx.owner,
                surface: HEARTBEAT_SURFACE.admin as never,
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
          const [had] = await raw<{ c: boolean }[]>`
            select requires_confirm as c from tools where owner_id = ${fx.owner} and slug = ${slug}`;
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
            // As it was (a tool that waits for approval anyway stays so: a
            // recipe in a later mode must not call it).
            await raw`update tools set requires_confirm = ${had?.c ?? false}
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
          (ITEM_KINDS as Record<string, { publicLink: boolean | string }>)[kind]!.publicLink ===
            true,
        run: (_role, _kind, _action, id) =>
          guard(async () => {
            const [s] = await raw<{ token: string }[]>`
            select token from shares
             where node_id = ${id} and revoked_at is null and contact_id is null limit 1`;
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
      contactEntry('contact-rw', shareable),
      contactEntry('contact-ro', shareable),
      contactDenyEntry(kinds.find((k) => k !== 'app' && shareable.has(k))!),
    ];
  };

  /** Judge one cell's outcome against the oracle and the row effect. */
  const judge = (
    cell: import('@mantle/db/matrix/a8-grid').A8Cell,
    want: { allow: true } | { allow: false; why: string },
    out: Outcome,
    before: string,
    after: string,
    item: { id: string; title: string },
  ): string | null => {
    const changed = after !== before;
    // A write the oracle denies that changed the row says so first, whatever
    // it answered (a raw text over a change is a change, not a crash).
    if (cell.action !== 'read' && !want.allow && changed) {
      return `changed, the oracle denies (${out.status ?? ''} ${out.text.slice(0, 100)})`;
    }
    const generic = out.thrown || (out.status ?? 0) >= 500 || (!out.ok && GENERIC.test(out.text));
    if (generic) return `a crash, not a refusal: ${out.status ?? ''} ${out.text.slice(0, 160)}`;
    if (cell.action === 'read') {
      const seen = out.ok && (out.text.includes(item.id) || out.text.includes(item.title));
      if (want.allow && !seen)
        return `not read, the oracle allows: ${out.status ?? ''} ${out.text.slice(0, 160)}`;
      if (!want.allow && out.ok) return `read, the oracle denies: ${out.text.slice(0, 100)}`;
      return null;
    }
    if (!want.allow) {
      if (out.ok) return `answered ok and changed nothing, the oracle denies`;
      return null;
    }
    if (!out.ok) return `refused, the oracle allows: ${out.status ?? ''} ${out.text.slice(0, 160)}`;
    if (!changed) return 'answered ok, no row changed';
    return g.effectMade(fx, cell, want, after);
  };

  it('each way in, in each check mode: a pairwise set of cells, each the oracle’s answer', async () => {
    const started = Date.now();
    const { sortFailures, CHECK_MODES } = await import('@mantle/db/matrix/a8-known-failures');
    // Every tool a cell calls resolves (L1): none drops out unseen.
    const slugs = ['node_read', ...Object.values(TOOL_EDIT), ...Object.values(TOOL_DELETE)];
    for (const b of t.BUILTIN_TOOLS) {
      if (b.mcpOnly) mcpOnly.add(b.slug);
      if (b.requiresConfirm) confirmGated.add(b.slug);
      if (b.policy?.peerRisky) peerRisky.add(b.slug);
    }
    const unresolved: string[] = [];
    for (const slug of slugs) {
      if (!(await m.asSystem(() => t.resolveTool(fx.owner, slug), 'test'))) unresolved.push(slug);
    }
    // A slug with no row is an MCP-only tool, and only that (its cells on a
    // turn, a run, a recipe and a heartbeat are counted, not run).
    expect(unresolved.sort(), 'tool slugs with no tool row').toEqual(
      slugs.filter((x) => mcpOnly.has(x)).sort(),
    );
    expect(unresolved, 'the MCP-only tools a cell calls').toEqual(['note_delete']);

    // The cells of each way in: picked once, run in each mode.
    type Cell = import('@mantle/db/matrix/a8-grid').A8Cell;
    const plan: { e: Entry; cells: Cell[]; candidates: number; na: number }[] = [];
    const naBy: Record<string, number> = {};
    for (const e of await entries()) {
      const candidates: Cell[] = [];
      let na = 0;
      for (const role of e.roles) {
        for (const kind of kinds) {
          for (const placement of o.GUIDE_PLACEMENTS) {
            for (const action of o.GUIDE_ACTIONS) {
              const can = e.supports(kind, action);
              if (can === false) continue;
              if (typeof can === 'string') {
                naBy[can] = (naBy[can] ?? 0) + 1;
                continue;
              }
              const want = o.expectedAccess(
                { surface: e.surface, placement, actor: e.actor },
                role,
                kind,
                action,
              );
              if ('na' in want) {
                na++;
                naBy[want.na] = (naBy[want.na] ?? 0) + 1;
              } else candidates.push({ actor: e.actor, role, kind, placement, action });
            }
          }
        }
      }
      const cells = g.pairwise(candidates, e.surface);
      for (const a of e.always ?? []) {
        const c: Cell = { actor: e.actor, ...a };
        if (!cells.some((x) => g.cellName(x) === g.cellName(c))) cells.push(c);
      }
      plan.push({ e, cells, candidates: candidates.length, na });
    }

    const lines: string[] = [];
    const unexpected: string[] = [];
    const fixed: string[] = [];
    let total = 0;
    let failed = 0;
    // The modes run in rising order, and must. The process's mode is the
    // greater of MANTLE_ACTOR_CHECK and the box's mode it last read
    // (packages/db/src/actor.ts actorCheckMode), which client.ts reads when
    // the pool opens and then once a minute; a session's own setting is
    // raised the same way (mantle_actor_check_mode: greatest(box, session)).
    // Off, warn, on: each step raises both, so a stale box read is never
    // above the mode a cell claims. Run on to off and the cached box mode
    // would hold the process at on for up to a minute. So the order is
    // asserted, and the process's read of the box is set to the box's new
    // mode at once (noteBoxActorCheckMode, what client.ts's own read calls),
    // and each mode checks the process's and the box's answer.
    const rank = { off: 0, warn: 1, on: 2 } as const;
    expect(
      CHECK_MODES.every((x, i) => i === 0 || rank[x] > rank[CHECK_MODES[i - 1]!]),
      'CHECK_MODES must rise: off, warn, on',
    ).toBe(true);
    for (const mode of CHECK_MODES) {
      // The box's mode and the process's, together.
      await raw`select mantle_set_actor_check(${mode})`;
      process.env.MANTLE_ACTOR_CHECK = mode;
      actorMode.noteBoxActorCheckMode(mode);
      expect(m.actorCheckMode(), `the process's check mode, check ${mode}`).toBe(mode);
      const [box] = await raw<{ m: string }[]>`select mantle_actor_check_mode() as m`;
      expect(box?.m, `the box's check mode, check ${mode}`).toBe(mode);
      const modeStarted = Date.now();
      const failures = new Map<string, string>();
      const counts: string[] = [];
      for (const { e, cells, candidates, na } of plan) {
        let pass = 0;
        let allow = 0;
        for (const c of cells) {
          const narrowed = e.narrow?.(c.kind, c.action) ?? null;
          const want = (
            narrowed
              ? { allow: false, why: narrowed }
              : o.expectedAccess(
                  { surface: e.surface, placement: c.placement, actor: c.actor },
                  c.role,
                  c.kind,
                  c.action,
                )
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
          const name = `${e.label ?? e.surface} ${g.cellName(c)}`;
          const why =
            judge(c, want, out, before, after, item) ??
            (misses.length ? `actor miss: ${JSON.stringify(misses).slice(0, 160)}` : null);
          if (why) failures.set(name, why);
          else pass++;
        }
        total += cells.length;
        counts.push(
          `  ${e.label ?? e.surface}${e.surface === 'contact-share' ? ` (${e.actor})` : ''}: ${cells.length} cells (${allow} allow) of ${candidates} candidates, ` +
            `${pass} pass, ${cells.length - pass} fail, ${na} not applicable`,
        );
      }
      // The surface cells' names (a grid cell's name starts with its actor);
      // a listed cell is known only while it fails, in this mode, for its
      // listed reason.
      const sorted = sortFailures(failures, false, mode);
      unexpected.push(...sorted.unexpected.map((u) => `[check ${mode}] ${u}`));
      fixed.push(...sorted.fixed);
      failed += failures.size;
      lines.push(
        `A8 surfaces, check ${mode}: ${plan.reduce((a, p) => a + p.cells.length, 0)} cells in ` +
          `${((Date.now() - modeStarted) / 1000).toFixed(1)} s, ${failures.size} fail ` +
          `(${failures.size - sorted.unexpected.length} known)`,
        ...counts,
        ...[...failures].map(([n, r]) => `  FAIL ${n}: ${r}`),
      );
    }
    console.log(
      [
        `A8 surfaces: ${total} cells over ${CHECK_MODES.length} check modes in ` +
          `${((Date.now() - started) / 1000).toFixed(1)} s, ${failed} fail`,
        ...Object.entries(naBy).map(([why, n]) => `  n/a ${n}: ${why}`),
        ...lines,
      ].join('\n'),
    );
    expect(unexpected, 'surface cells that fail and are not known failures').toEqual([]);
    expect(fixed, 'known failures that pass now: take them off the list').toEqual([]);
    expect(naBy, 'the surface cells not applicable, by reason').toEqual(NOT_APPLICABLE);
  }, 1_800_000);
});

/** The surface cells not applicable, by reason, over every way in (L1:
 *  none drops out uncounted). */
const NOT_APPLICABLE: Readonly<Record<string, number>> = {
  'a snapshot copy carries no link or share': 15,
  'a snapshot copy holds no grant but its home': 60,
  'an Admin-homed item holds no grant but its home': 132,
  "no snapshot copy of a app is made (only an accepted item's kinds)": 142,
  "no snapshot copy of a branch is made (only an accepted item's kinds)": 79,
  "no snapshot copy of a event is made (only an accepted item's kinds)": 202,
  "no snapshot copy of a formula is made (only an accepted item's kinds)": 204,
  "no snapshot copy of a recall is made (only an accepted item's kinds)": 91,
  "no snapshot copy of a task is made (only an accepted item's kinds)": 208,
  'no tool row: note_delete is MCP only': 144,
};
