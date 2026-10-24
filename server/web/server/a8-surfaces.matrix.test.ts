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
 *                login's READ-ONLY key (resolveMcpCaller); and, as
 *                mcp-key-rw, its read-write key on a page's or a note's
 *                content edit (F6: a key changes none others read)
 *   peer         a linked brain with Acts as the login and Write on
 *                (resolveMcpCaller with its peer token)
 *   mcp-stdio    the stdio server (buildMantleMcpServer) as login(owner)
 *   web-turn     dispatchTool with the turn caller in the assistant's turn
 *                scope (withAgentScope, the role's own workspace)
 *   team-turn    the same, on the team surface (the logins outside Admin)
 *   telegram     the same, on the Telegram surface (the chat's login)
 *   run          a run item through the product's own executor
 *                (executeRunItem, server/web/lib/runs/execute-item.ts): a
 *                run of the role's login as createRun makes it (the stamp
 *                trigger leaves its workspace NULL, Admin's: run_plan is
 *                Admin only, so a login outside Admin has no other run), one
 *                tool_call item, run as the runs worker runs it; and an
 *                Admin user's run demoted out of Admin before its item runs
 *                (run-demoted, refused: fail closed)
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
 *                (contact-rw) and off (contact-ro); and two denies
 *                (contact-share-deny): an Informational app's data with
 *                Can write on, and the db-broker of a read share of a kind
 *                that is no app
 *
 * Every cell runs in each actor check mode (off; warn; on, the fleet's
 * mode): the box's mode (mantle_set_actor_check) and the process's
 * (MANTLE_ACTOR_CHECK) set together, in that order (see CHECK_MODES below).
 *
 * A cell passes only on the right row effect (the probe of the SQL grid):
 * allowed is ok and the change made; refused is no change and a refusal
 * that is not a crash (a 5xx, a thrown error, a raw database or runtime
 * text: GENERIC). A refused write that changed the row says so first, crash
 * or not. A narrowed deny (one the oracle cannot see: a tool that waits for
 * approval, a peer's risky tool, a run outside Admin) must be refused in
 * its own words. The cells of a surface are picked in a stable order (a8-grid.ts
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

/** What a way in answered. `approvalWait`: a run item that failed as
 *  requires_confirm, a refusal only on a cell narrowed for it. */
type Outcome = {
  ok: boolean;
  text: string;
  status?: number;
  thrown?: boolean;
  approvalWait?: boolean;
};

/** A deny the guide gives a way in and the oracle cannot see (it knows no
 *  tools): why, and the words the refusal must carry. */
type Narrow = { why: string; says?: RegExp };

/** A crash, never a deny: a 5xx, a throw, a raw database or runtime error
 *  in the reply. The one list is the tool cells' (@mantle/db
 *  matrix/test-support/a8-tool-cells.ts A8_GENERIC), loaded with the
 *  database modules in beforeAll. */
let GENERIC: RegExp;

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

/** A refusal a narrowed run or recipe cell must name: the call waits for
 *  approval (execute-item.ts "requires operator approval"; recipe.ts
 *  "recipes can't call tools that require approval"). */
const APPROVAL_WAIT = /requires? (operator )?approval/;
/** The refusal of an owner-side tool on a surface that is not the owner's
 *  (packages/tools/src/surface.ts OWNER_ONLY_ERROR). */
const OWNER_SIDE = /owner-side tool: not available here/;
/** The refusal of a run whose login is no user of Admin (withRunScope:
 *  a run with no workspace is Admin's, and withAgentScope refuses a login
 *  with no seat there). */
const NOT_ADMIN_USER = /not a user of the Admin workspace/;

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
  /** The surfaces a heartbeat's turn names (heartbeats/surface.ts, what
   *  fire.ts's runToolLoop call sends): a workspace assistant's fire, and
   *  the Admin assistant's (Telegram only when the heartbeat names a chat
   *  paired to the login it answers, which the fixture's do not). */
  const HEARTBEAT_SURFACE = {} as Record<'workspace' | 'admin', unknown>;
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
    GENERIC = (await import('@mantle/db/matrix/a8-tool-cells')).A8_GENERIC;
    o = await import('@mantle/db/matrix/guide-oracle');
    runRoute = (await import('./run-route')).runRoute;
    runs = await import('@mantle/runs');
    runItem = await import('../lib/runs/execute-item');
    actorMode = await import('../../../packages/db/src/actor');
    const hb = await import('../../../packages/runtime/src/heartbeats/surface');
    const none = { scoped: true, telegramChat: null, pairedTelegram: null };
    HEARTBEAT_SURFACE.workspace = hb.heartbeatSurface({ ...none, adminAssistant: false });
    HEARTBEAT_SURFACE.admin = hb.heartbeatSurface({ ...none, adminAssistant: true });
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    kinds = g.A8_KINDS;
    fx = await g.buildA8Fixture(raw);
    await g.installProbe(raw);
    // The box at off (the lowest mode) while the brain is set up; each
    // run of the cells sets its mode (CHECK_MODES, off to on).
    await raw`select mantle_set_actor_check('off', 50, 'test')`;
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
    const support = await import('@mantle/content/test-support');
    const auth = await import('../lib/auth/tokens');
    contactId = randomUUID();
    await raw`insert into nodes (id, owner_id, type, title, path)
      values (${contactId}, ${fx.owner}, 'contact', ${`${fx.tag} contact`}, 'contacts')`;
    await m.asSystem(() => support.enableContactSharing(fx.owner, contactId), 'test');
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

  /** A page's or a note's content edit through its tool, or null: the cells
   *  of the read-write key (F6), the one way in that runs page edits. */
  const contentEditCall = (kind: string, action: GuideAction, id: string) => {
    if (action === 'edit' && kind === 'note') {
      return { slug: 'note_update', input: { id, title: `${fx.tag} edited` } };
    }
    if (action === 'edit' && kind === 'page') {
      return { slug: 'page_update', input: { id, title: `${fx.tag} edited` } };
    }
    if (action === 'editDraft' && kind === 'page') {
      return { slug: 'page_update_draft', input: { id, markdown: `${fx.tag} draft` } };
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
     *  knows no tools): the reason and the refusal's words, else null. */
    narrow?: (kind: string, action: GuideAction, role: GuideRole | null) => Narrow | null;
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
  const ownerSide = new Set<string>();
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
        return { why: `a peer may not call ${tc.slug}: a risky tool its list does not allow` };
      }
      // Approval, not access, for everyone (the owner too). A recipe step
      // calls no tool that waits for approval (packages/tools/src/dispatch.ts,
      // classifyRecipeStepTool: 'confirm'); a run item never runs one
      // headless (server/web/lib/runs/execute-item.ts, `tool.requiresConfirm`
      // before dispatch: "Confirm-gated tools never run headless"), the
      // phase waits on an ask_human step instead.
      if (surface === 'recipe' && confirmGated.has(tc.slug)) {
        return {
          why: `a recipe step may not call ${tc.slug}: it waits for approval`,
          says: APPROVAL_WAIT,
        };
      }
      if (surface === 'run' && confirmGated.has(tc.slug)) {
        return {
          why: `a run item may not run ${tc.slug}: it waits for approval`,
          says: APPROVAL_WAIT,
        };
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
  /** The owner's decision of 2026-10-15 (plan s34: a delete is an archive),
   *  run on the web and over MCP whatever the pick: each Admin user's delete
   *  of an app homed in Admin, and the home Moderator's of an app homed in
   *  H, at its kind's root and in its folder, allowed (to Recently deleted). */
  const APP_DELETES = [
    ...(['owner', 'admin'] as const).map((role) => ({
      role,
      kind: 'app',
      placement: 'admin' as const,
      action: 'delete' as const,
    })),
    ...(['root', 'folder'] as const).map((placement) => ({
      role: 'homeModerator' as const,
      kind: 'app',
      placement,
      action: 'delete' as const,
    })),
  ];
  const MEMBERS: GuideRole[] = ['homeModerator', 'writeGrant', 'readGrant', 'outsider'];
  /** A contact share of the item (Can write: `write`), made for the cell. */
  const contactShare = async (id: string, write: boolean): Promise<string> => {
    const support = await import('@mantle/content/test-support');
    const [made] = await m.asSystem(
      () => support.createContactShares(fx.owner, id, [contactId], write),
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

  /** Two writes of a contact share the pairwise pick cannot reach: the
   *  oracle knows no Informational switch, and the contact-share entry sends
   *  app data to an app only. With Can write on (contact-rw), the app's data
   *  while the app is Informational ("Informational wins over a share's Can
   *  write", the /s db-broker, access matrix L23): 403 read-only, "This app
   *  is read-only.", not the Can write off answer. And the db-broker of a
   *  contact share of `kind`, no app: Can write is an app's only
   *  (createContactShares refuses it on another kind), so the share is the
   *  contact's read share (contact-ro), and the broker serves an app only:
   *  404 not found. */
  const contactDenyEntry = (actor: 'contact-rw' | 'contact-ro', kind: string): Entry => ({
    surface: 'contact-share',
    label: 'contact-share-deny',
    actor,
    roles: [null],
    supports: () => false,
    always: [{ role: null, kind, placement: 'root', action: 'appData' }],
    narrow: (k) =>
      k === 'app'
        ? {
            why: 'an Informational app’s data is read only, Can write or not',
            says: /^403 .*"reason":"read-only","error":"This app is read-only\."/,
          }
        : {
            why: `a share of a ${k} has no app data: the /s broker serves an app only`,
            says: /^404 .*"error":"not found"/,
          },
    run: (_role, k, _action, id) =>
      guard(async () => {
        if (k === 'app') {
          await raw.begin(async (tx) => {
            await tx.unsafe(g.FIXTURE_ACTOR);
            await tx`update apps set manifest = '{}'::jsonb, published_build = ${PUBLISHED}::jsonb,
                            data_read_only = true
                      where node_id = ${id}`;
          });
        }
        const token = await contactShare(id, actor === 'contact-rw');
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

  /** A run item, through the product's run path whole: a run of the role's
   *  login (no agent: the login's own MCP client planned it), as createRun
   *  makes it (no workspace: the stamp trigger, 0250, takes the planning
   *  agent's, and with none leaves it NULL, Admin's), its one tool_call
   *  item made ready by createRun and run by executeRunItem as the runs
   *  worker runs it (server/web/workers/runs.ts, under the worker's system
   *  actor). The executor refuses a tool that waits for approval before
   *  dispatch, runs the rest as the run's login as it is now, in
   *  withRunScope, on the surface {kind:'owner', via:'run', loginId}.
   *  `demote`: the login leaves Admin (its role made member and its seat
   *  there removed, as the product's removal does) after the run is made,
   *  before its item runs, and comes back after. The outcome: done is ok; failed as
   *  tool_error a refusal; failed as requires_confirm a refusal on a cell
   *  narrowed for it (approvalWait); anything else (still ready or
   *  unclaimed, no item, internal_error, tool_missing, bad_payload,
   *  agent_missing, banned_tool) a crash. */
  const runItemCall = (
    role: GuideRole | null,
    slug: string,
    input: Record<string, unknown>,
    demote = false,
  ): Promise<Outcome> =>
    guard(async () => {
      const r = role!;
      const login = fx.logins[r];
      const { runId } = await m.runAsSystem('worker:runs', () =>
        runs.createRun(m.db, {
          ownerId: fx.owner,
          title: `${fx.tag} run`,
          loginId: login,
          plan: {
            kind: 'seq',
            children: [{ kind: 'tool_call', payload: { tool: slug, args: input } }],
          } as never,
        }),
      );
      const [item] = await raw<{ id: string; ws: string | null }[]>`
        select i.id::text as id, r.workspace_id::text as ws
          from run_items i join runs r on r.id = i.run_id
         where i.run_id = ${runId} and i.kind = 'tool_call'`;
      if (!item) return { ok: false, thrown: true, text: 'RUN CRASH no tool_call item' };
      if (item.ws !== null) {
        return { ok: false, thrown: true, text: `RUN CRASH the run is stamped ${item.ws}` };
      }
      const seats = demote
        ? await raw<{ ws: string; mod: boolean }[]>`
            select workspace_id::text as ws, moderator as mod
              from workspace_users where login_id = ${login}`
        : [];
      try {
        if (demote) {
          // As the product's removal from Admin does (lib/workspaces.ts: the
          // role change and the seat's row, in one transaction).
          await raw.begin(async (tx) => {
            await tx`update auth.users set role = 'member' where id = ${login}`;
            await tx`delete from workspace_users
                      where login_id = ${login} and workspace_id = ${fx.ws.admin}`;
          });
          const [left] = await raw<{ n: number }[]>`
            select count(*)::int as n from workspace_users
             where login_id = ${login} and workspace_id = ${fx.ws.admin}`;
          if (left!.n !== 0) return { ok: false, thrown: true, text: 'RUN CRASH not demoted' };
        }
        await m.runAsSystem('worker:runs', () => runItem.executeRunItem(item.id));
      } finally {
        if (demote) {
          // As it was: the role, then the seats exactly (the role change
          // also gives and takes the Team seat the fixture removed).
          await raw.begin(async (tx) => {
            await tx`update auth.users set role = 'admin' where id = ${login}`;
            await tx`delete from workspace_users where login_id = ${login}`;
            for (const st of seats) {
              await tx`insert into workspace_users (workspace_id, login_id, moderator)
                        values (${st.ws}, ${login}, ${st.mod})`;
            }
          });
        }
      }
      const [row] = await raw<
        {
          state: string;
          result: {
            output?: unknown;
            failure?: { type?: string; message?: string };
          } | null;
        }[]
      >`select state, result from run_items where id = ${item.id}`;
      if (row?.state === 'done') {
        return { ok: true, text: JSON.stringify(row.result?.output ?? '') };
      }
      const f = row?.result?.failure;
      const said = `${row?.state ?? 'gone'} ${f?.type ?? ''}: ${f?.message ?? ''}`;
      if (row?.state === 'failed' && f?.type === 'tool_error') return { ok: false, text: said };
      if (row?.state === 'failed' && f?.type === 'requires_confirm') {
        return { ok: false, text: said, approvalWait: true };
      }
      return { ok: false, thrown: true, text: `RUN CRASH ${said}` };
    });
  const teamEntry = toolEntry(
    'team-turn',
    'turn',
    MEMBERS,
    inTurn(
      (r) => ({ kind: 'team', loginId: fx.logins[r] }),
      () => t.turnCaller(),
    ),
  );
  const runEntry = toolEntry('run', 'turn', ALL, (role, slug, input) =>
    runItemCall(role, slug, input),
  );

  /** A call over MCP with the login's read-write key (F6's cells). */
  const keyRwCall = async (
    role: GuideRole | null,
    slug: string,
    input: Record<string, unknown>,
  ): Promise<Outcome> => mcpCall(await bearer(keyRw[role!]!), loginActor(role!), slug, input);

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
        always: APP_DELETES,
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
        always: APP_DELETES,
      },
      toolEntry('mcp-key', 'login-ro', ALL, async (role, slug, input) =>
        mcpCall(await bearer(keyRo[role!]!), loginActor(role!), slug, input),
      ),
      {
        // F6 against the product: the login's read-write key over MCP, a
        // page's or a note's content only ("A key may not change the
        // content of a page or a note others read"; the read-only key
        // above writes nothing, so its cells never reach the rule).
        ...toolEntry('mcp-key', 'login', ALL, keyRwCall),
        label: 'mcp-key-rw',
        supports: (kind, action) => contentEditCall(kind, action, 'x') !== null,
        run: (role, kind, action, id) => {
          const tc = contentEditCall(kind, action, id)!;
          return keyRwCall(role, tc.slug, tc.input);
        },
        // The owner's own Admin-homed note (an open link) and a page's draft
        // in the folder, whatever the pick.
        always: [
          { role: 'owner', kind: 'note', placement: 'admin', action: 'edit' },
          { role: 'writeGrant', kind: 'page', placement: 'folder', action: 'editDraft' },
        ],
      },
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
      {
        ...teamEntry,
        // A surface limit the oracle cannot see: the team chat calls no
        // owner-side tool (`app_delete` is one: ownerOnly), for everyone.
        // The home Moderator's app delete, allowed by hand (plan s34), is
        // run whatever the pick so the limit stays pinned.
        narrow: (kind, action, role) => {
          const tc = toolCall(kind, action, 'x');
          return (
            teamEntry.narrow!(kind, action, role) ??
            (tc && ownerSide.has(tc.slug)
              ? { why: `the team chat calls no ${tc.slug}: an owner-side tool`, says: OWNER_SIDE }
              : null)
          );
        },
        always: [{ role: 'homeModerator', kind: 'app', placement: 'root', action: 'delete' }],
      },
      toolEntry(
        'telegram',
        'turn',
        ALL,
        inTurn(
          () => ({ kind: 'telegram' }),
          () => t.turnCaller(),
        ),
      ),
      {
        ...runEntry,
        // run_plan is Admin only (surface-decisions.json adminOnly), and the
        // executor refuses an agent outside Admin (below_admin): a run's
        // login outside Admin has no run but one with no workspace, Admin's,
        // which it is no user of. The approval wait comes first (the
        // executor checks it before it enters the run's scope).
        narrow: (kind, action, role) =>
          runEntry.narrow!(kind, action, role) ??
          (role && !isAdminUser(role)
            ? { why: 'run_plan is Admin only', says: NOT_ADMIN_USER }
            : null),
      },
      {
        // An Admin user's run whose login is demoted out of Admin before its
        // item runs: refused, fail closed (the executor reads the login as
        // it is now, and withRunScope's Admin scope asks its seat).
        surface: 'run',
        label: 'run-demoted',
        actor: 'turn',
        roles: [],
        supports: () => false,
        always: [{ role: 'admin', kind: 'note', placement: 'root', action: 'edit' }],
        narrow: () => ({
          why: 'its login left Admin before the item ran: fail closed',
          says: NOT_ADMIN_USER,
        }),
        run: (role, kind, action, id) => {
          const tc = toolCall(kind, action, id)!;
          return runItemCall(role, tc.slug, tc.input, true);
        },
      },
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
      contactDenyEntry('contact-rw', 'app'),
      contactDenyEntry(
        'contact-ro',
        kinds.find((k) => k !== 'app' && shareable.has(k))!,
      ),
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
    narrowed: Narrow | null,
  ): string | null => {
    const changed = after !== before;
    // A write the oracle denies that changed the row says so first, whatever
    // it answered (a raw text over a change is a change, not a crash).
    if (cell.action !== 'read' && !want.allow && changed) {
      return `changed, the oracle denies (${out.status ?? ''} ${out.text.slice(0, 100)})`;
    }
    const generic =
      out.thrown ||
      (out.status ?? 0) >= 500 ||
      (!out.ok && GENERIC.test(out.text)) ||
      // A run item that waits for approval is a refusal only where the
      // cell says so: anywhere else it is a run that never ran.
      (out.approvalWait && !narrowed);
    if (generic) return `a crash, not a refusal: ${out.status ?? ''} ${out.text.slice(0, 160)}`;
    // A narrowed deny is refused for its own reason, in its own words.
    if (!want.allow && !out.ok && narrowed?.says) {
      const said = `${out.status ?? ''} ${out.text}`.trim();
      if (!narrowed.says.test(said)) {
        return `refused, but not as ${narrowed.says} says (${narrowed.why}): ${said.slice(0, 160)}`;
      }
    }
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
      if (b.ownerOnly) ownerSide.add(b.slug);
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
    /** The narrowed cells, by way in and reason (each runs, as a deny). */
    const narrowBy: Record<string, number> = {};
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
      for (const c of cells) {
        const n = e.narrow?.(c.kind, c.action, c.role);
        if (n) {
          const key = `${e.label ?? e.surface}: ${n.why}`;
          narrowBy[key] = (narrowBy[key] ?? 0) + 1;
        }
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
      await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
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
        let narrow = 0;
        for (const c of cells) {
          const narrowed = e.narrow?.(c.kind, c.action, c.role) ?? null;
          if (narrowed) narrow++;
          const want = (
            narrowed
              ? { allow: false, why: narrowed.why }
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
            judge(c, want, out, before, after, item, narrowed) ??
            (misses.length ? `actor miss: ${JSON.stringify(misses).slice(0, 160)}` : null);
          if (why) failures.set(name, why);
          else pass++;
        }
        total += cells.length;
        counts.push(
          `  ${e.label ?? e.surface}${e.surface === 'contact-share' ? ` (${e.actor})` : ''}: ${cells.length} cells (${allow} allow, ${narrow} narrowed) of ${candidates} candidates, ` +
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
        ...Object.entries(narrowBy).map(([why, n]) => `  narrowed ${n}: ${why}`),
        ...lines,
      ].join('\n'),
    );
    expect(unexpected, 'surface cells that fail and are not known failures').toEqual([]);
    expect(fixed, 'known failures that pass now: take them off the list').toEqual([]);
    expect(naBy, 'the surface cells not applicable, by reason').toEqual(NOT_APPLICABLE);
    expect(narrowBy, 'the narrowed surface cells, by way in and reason').toEqual(NARROWED);
  }, 1_800_000);
});

/** The narrowed surface cells (a deny the oracle cannot see), by way in
 *  and reason: each runs, and its count is pinned so none slips in or out
 *  unseen. */
const NARROWED: Readonly<Record<string, number>> = {
  'peer: a peer may not call app_delete: a risky tool its list does not allow': 6,
  'team-turn: the team chat calls no app_delete: an owner-side tool': 3,
  'run: run_plan is Admin only': 61,
  'run: a run item may not run app_delete: it waits for approval': 5,
  'run-demoted: its login left Admin before the item ran: fail closed': 1,
  'recipe: a recipe step may not call app_delete: it waits for approval': 3,
  'contact-share-deny: an Informational app’s data is read only, Can write or not': 1,
  'contact-share-deny: a share of a file has no app data: the /s broker serves an app only': 1,
};

/** The surface cells not applicable, by reason, over every way in (L1:
 *  none drops out uncounted). */
const NOT_APPLICABLE: Readonly<Record<string, number>> = {
  'a snapshot copy carries no link or share': 15,
  'a snapshot copy holds no grant but its home': 60,
  'an Admin-homed item holds no grant but its home': 144,
  "no snapshot copy of a app is made (only an accepted item's kinds)": 148,
  "no snapshot copy of a branch is made (only an accepted item's kinds)": 79,
  "no snapshot copy of a event is made (only an accepted item's kinds)": 202,
  "no snapshot copy of a formula is made (only an accepted item's kinds)": 204,
  "no snapshot copy of a present is made (only an accepted item's kinds)": 91,
  "no snapshot copy of a recall is made (only an accepted item's kinds)": 91,
  "no snapshot copy of a task is made (only an accepted item's kinds)": 208,
  'no tool row: note_delete is MCP only': 144,
};
