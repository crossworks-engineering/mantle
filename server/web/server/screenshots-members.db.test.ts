/**
 * Area screenshots between logins (docs/files.md, "Screenshots"): every
 * screenshot is private to the login that took it, so no other login lists
 * or fetches it, an Admin user's included. On a migrated scratch database
 * switched to workspaces, in warn and in on (the actor and the edit check
 * together, as on the fleet), with two plain members A and B who share a
 * workspace W (so they do read some of the same things) and two Admin users
 * X and Y (Moderators of Admin, so they read the same Auto-filed folder):
 *
 *  - each saves a screenshot through the full HTTP pipeline (runRoute,
 *    POST /api/screenshots, multipart): 201, a member's landed in its own
 *    private workspace, an Admin user's in Auto-filed / Screenshots /
 *    <month> in Admin, every one private to its login (nodes.login_id);
 *  - the routes the feature reads by: B fetches A's by id (the detail,
 *    `?raw=1` the bytes, `?thumb=1`) as the same 404 as an id that does not
 *    exist, and neither Recent (`?recent=1`) nor the Files root
 *    (`?parent=files`) lists it for B; A fetches and lists its own;
 *  - the MCP tool `screenshots` on each login's own surface
 *    (prepareCallerTools, an OAuth connection): B's list holds its own and
 *    not A's, and B's show of A's id is refused as "screenshot not found";
 *    A's list holds its own and not B's, and A's show returns its metadata
 *    and the picture;
 *  - the same between the Admin users (screenshots audit, M1): Y fetches
 *    X's by no route, neither Recent nor the Screenshots month folder they
 *    both see lists it for Y, and Y's MCP list and show do not hold it; X
 *    reads its own;
 *  - and across: an Admin user fetches, lists and shows no member's, and a
 *    member no Admin user's;
 *  - and a linked brain (screenshots audit, H1): a full-scope peer with a
 *    standing grant on every category it may hold finds none by the
 *    federation query (the list and the ranked search), reads none by the
 *    node read (the same 404 as an id that does not exist) and gets no
 *    passage of one by the passage search, while a node shared with it per
 *    node is found, read and searched (the control); Y's peer node picker
 *    lists none of X's (nor its own), and Y's share of X's to the peer is
 *    refused, as a node not found, while Y shares the peer's own node;
 *  - the settings area's diagnostics (screenshots audit round 4): Y's
 *    landed view (/api/debug/integrity/landed), its delete, the facts list
 *    (/api/debug/facts), the audit's samples (node ids and fact text) and
 *    the overview (its failures and errors) hold none of X's or A's
 *    screenshots, the facts learned from them or their failed runs; Y's
 *    own show (the control).
 *
 * The rows are the database's row security (the scope the gate enters):
 * packages/files/src/screenshots.db.test.ts holds the save and the reads
 * unscoped.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/screenshots-members.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** The database's or the runtime's own words: never in a reply. */
const RAW =
  /Failed query|withSystemTx|runInSystemTx|SQLSTATE|DrizzleQueryError|drizzle-orm|permission denied for|violates|duplicate key|does not exist|\n\s+at \S/i;

type Mode = 'warn' | 'on';
/** Members A and B; Admin users X and Y. */
type Who = 'a' | 'b' | 'x' | 'y';
const ADMINS: readonly Who[] = ['x', 'y'];
type McpOutcome = {
  ok: boolean;
  text: string;
  out: Record<string, unknown>;
  images: Array<{ mimeType?: string; data?: string }>;
};
type Reply = {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
};

describe.skipIf(!DB_URL)('area screenshots: no login lists or fetches another login’s', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let ls: typeof import('@mantle/mcp-core');
  let f: typeof import('@mantle/files');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `shotm${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const L: Record<Who, string> = {
    a: randomUUID(),
    b: randomUUID(),
    x: randomUUID(),
    y: randomUUID(),
  };
  const ws = { admin: '', w: '' };
  const recorded: string[] = [];
  /** The linked brain (H1): made once, by the owner, on first use. */
  const peer = { id: '', nodeId: '', token: '' };

  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:shotm', fn) as Promise<T>;

  const setMode = async (mode: Mode) => {
    await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
    await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
    process.env.MANTLE_ACTOR_CHECK = mode;
    actorMode.noteBoxActorCheckMode(mode);
    expect(m.actorCheckMode()).toBe(mode);
  };

  /** One request through the full pipeline as `who` (a raw body, or
   *  `{ json }` for a JSON one). */
  const route = async (
    name: string,
    who: Who,
    method: string,
    url: string,
    rawBody?: BodyInit | { json: unknown },
  ) => {
    const res =
      rawBody && typeof rawBody === 'object' && 'json' in rawBody
        ? await runRoute(L[who], method, url, rawBody.json)
        : await runRoute(L[who], method, url, undefined, rawBody ? { rawBody } : {});
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');
    const type = res.headers.get('content-type') ?? '';
    recorded.push(
      `${name}: ${res.status} ${type.startsWith('image/') ? `<${bytes.length} bytes>` : text.slice(0, 160).replace(/\s+/g, ' ')}`,
    );
    if (!type.startsWith('image/')) expect(text, name).not.toMatch(RAW);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not JSON: the status says it
    }
    return { status: res.status, json, bytes, type, text };
  };

  /** Save a screenshot as `who` (POST /api/screenshots): its file id. */
  const shoot = async (mode: Mode, who: Who, note: string) => {
    const form = new FormData();
    form.append(
      'meta',
      JSON.stringify({
        screen: 'Files',
        route: '/files',
        note,
        capturedAt: new Date().toISOString(),
      }),
    );
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'shot.png');
    const r = await route(
      `${mode} ${who} POST /api/screenshots`,
      who,
      'POST',
      '/api/screenshots',
      form,
    );
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = String((r.json.file as { id?: string } | undefined)?.id ?? '');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    return id;
  };

  /** The peer, with a standing grant on every category it may hold (the
   *  full scope), and the peer's own node shared per node with a passage
   *  of its own (the control the reads must find). */
  const ensurePeer = async () => {
    if (peer.id) return;
    const made = await runRoute(owner, 'POST', '/api/peers', {
      displayName: `${tag} peer`,
      baseUrl: 'https://peer.example.invalid',
    });
    const body = (await made.json()) as {
      peer?: { id: string; nodeId: string };
      inboundToken?: string;
    };
    expect(made.status, JSON.stringify(body)).toBe(201);
    peer.id = body.peer!.id;
    peer.nodeId = body.peer!.nodeId;
    peer.token = body.inboundToken!;
    const { PEER_SHAREABLE_TYPES } = await import('@mantle/content');
    for (const nodeType of PEER_SHAREABLE_TYPES) {
      const r = await runRoute(owner, 'POST', `/api/peers/${peer.id}/shares`, { nodeType });
      expect(r.status, nodeType).toBe(201);
    }
    const share = await runRoute(owner, 'POST', `/api/peers/${peer.id}/shares`, {
      nodeId: peer.nodeId,
    });
    expect(share.status).toBe(201);
    await asSystemTx(
      (tx) => tx`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
        values (${owner}, ${peer.nodeId}, 0, ${`${tag} the peer passage`}, ${`[${VEC.join(',')}]`}::vector)`,
    );
  };

  /** A raw write fixture as the system (mantle.actor set in its own
   *  transaction): with the actor check on, a write that names no actor is
   *  refused, as every write outside a call is. */
  const asSystemTx = async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) => {
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await fn(tx);
    });
  };

  /** A passage for each screenshot, on the question's own vector: the
   *  passage search would rank it first if it reached it. */
  const passagesFor = async (ids: string[]) => {
    await asSystemTx(async (tx) => {
      for (const id of ids) {
        await tx`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
          values (${owner}, ${id}, 0, ${`${tag} vision text of ${id}`}, ${`[${VEC.join(',')}]`}::vector)`;
      }
    });
  };

  /** One federation call as the peer (its bearer token, no session). */
  const asPeer = async (name: string, method: string, url: string, body?: unknown) => {
    const res = await runRoute(null, method, url, body, {
      headers: { authorization: `Bearer ${peer.token}` },
    });
    const text = await res.text();
    recorded.push(`${name}: ${res.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    expect(text, name).not.toMatch(RAW);
    return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text };
  };

  /** Each node's login_id (the login it is private to), by id. */
  const loginsOf = async (ids: string[]): Promise<Record<string, string | null>> => {
    const rows = await raw<{ id: string; login: string | null }[]>`
      select id::text as id, login_id::text as login from nodes where id in ${raw(ids)}`;
    return Object.fromEntries(rows.map((r) => [r.id, r.login]));
  };

  /** `who` fetches `id` by every file route as the same 404 as an id that
   *  does not exist, and gets none of its bytes. */
  const fetchedByNoRoute = async (mode: Mode, who: Who, owner: Who, id: string) => {
    const missing = randomUUID();
    for (const q of ['', '?raw=1', '?thumb=1']) {
      const theirs = await route(
        `${mode} ${who} GET ${owner}'s file${q}`,
        who,
        'GET',
        `/api/files/files/${id}${q}`,
      );
      const none = await route(
        `${mode} ${who} GET missing file${q}`,
        who,
        'GET',
        `/api/files/files/${missing}${q}`,
      );
      expect(theirs.status, `${who} GET ${owner}'s${q}`).toBe(404);
      expect(theirs.json, `${who} GET ${owner}'s${q}`).toEqual(none.json);
      expect(theirs.bytes.includes(PNG.subarray(8)), `${who} GET ${owner}'s${q}: no bytes`).toBe(
        false,
      );
    }
  };

  /** The ids a files list route answers `who`. */
  const listedBy = async (name: string, who: Who, url: string): Promise<string[]> => {
    const r = await route(name, who, 'GET', url);
    expect(r.status, name).toBe(200);
    return ((r.json.files ?? []) as Array<{ id: string }>).map((x) => x.id);
  };

  /** One call of the MCP tool `screenshots` on `who`'s own surface. */
  const viaMcp = async (who: Who, input: Record<string, unknown>): Promise<McpOutcome> => {
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const server = new McpServer({ name: tag, version: '0' });
    const caller = {
      role: ADMINS.includes(who) ? ('admin' as const) : ('member' as const),
      anchorId: owner,
      loginId: L[who],
      via: 'oauth' as const,
      write: true,
      oauthClientId: tag,
    };
    ls.registerPreparedTools(server, await ls.prepareCallerTools(caller as never));
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: tag, version: '0' });
    await Promise.all([server.connect(x), client.connect(y)]);
    try {
      const r = (await m.runAsActor(m.loginActor(L[who], 'rw'), () =>
        client.callTool({ name: 'screenshots', arguments: input }),
      )) as Reply;
      const content = r.content ?? [];
      const text = content.map((c) => c.text ?? '').join(' ');
      let out: Record<string, unknown> = {};
      try {
        out = JSON.parse(content[0]?.text ?? '') as Record<string, unknown>;
      } catch {
        // a refusal's words
      }
      const images = content.filter((c) => c.type === 'image');
      return { ok: !(r.isError ?? false), text, out, images };
    } finally {
      await client.close();
    }
  };
  const mcpIds = (o: McpOutcome) =>
    ((o.out.screenshots ?? []) as Array<{ id: string }>).map((s) => s.id);

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'screenshots-members-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'screenshots-members-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the screenshots members test', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    ls = await import('@mantle/mcp-core');
    f = await import('@mantle/files');
    actorMode = await import('../../../packages/db/src/actor');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    // A real pg-boss schema, as a box has one: the corpus audit's queue
    // checks read pgboss.job, which the migrations do not make. pg-boss
    // installs as the migrator (pgboss:init), its routines are taken from
    // PUBLIC as pgboss:init does, and the app's roles read its tables as the
    // next migrate grants them (applyRuntimeGrants).
    const { PgBoss } = await import('pg-boss');
    const boss = new PgBoss({ connectionString: scratch.url, schema: 'pgboss' });
    await boss.start();
    await boss.stop({ graceful: false, timeout: 5_000 });
    await m.revokePgBossRoutines(raw);
    await (await import('@mantle/db/runtime-role')).applyRuntimeGrants(raw);

    await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'Owner'),
             (${L.a}, ${`${tag}-a@example.invalid`}, 'x', false, 'member', 'Member A'),
             (${L.b}, ${`${tag}-b@example.invalid`}, 'x', false, 'member', 'Member B'),
             (${L.x}, ${`${tag}-x@example.invalid`}, 'x', false, 'admin', 'Admin X'),
             (${L.y}, ${`${tag}-y@example.invalid`}, 'x', false, 'admin', 'Admin Y')`;
    await raw`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    ws.admin = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
                                  where owner_id = ${owner} and is_admin`
    )[0]!.id;
    ws.w = (
      await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} W`}) returning id::text as id`
    )[0]!.id;
    // Two plain members: no seat in Admin, both users of W.
    await raw`delete from workspace_users where workspace_id = ${ws.admin}
               and login_id in (${L.a}, ${L.b})`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.w}, ${L.a}, false), (${ws.w}, ${L.b}, false)`;
    // Two Admin users: Moderators of Admin, so both may change the Files
    // root and read Auto-filed.
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.admin}, ${L.x}, true), (${ws.admin}, ${L.y}, true)
      on conflict (workspace_id, login_id) do update set moderator = true`;
    await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
    await sys(() => f.ensureFilesRootBranch(owner));
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    console.log(['screenshots between members, each call:', ...recorded].join('\n  '));
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const mode of ['warn', 'on'] as const) {
    describe(`check mode ${mode}`, () => {
      const shot: Record<Who, string> = { a: '', b: '', x: '', y: '' };
      /** The Auto-filed / Screenshots month folder the Admin users' land in. */
      let shotFolder = '';

      it('each member saves its own, landed in its own private workspace', async () => {
        await setMode(mode);
        shot.a = await shoot(mode, 'a', `${tag} a ${mode}`);
        shot.b = await shoot(mode, 'b', `${tag} b ${mode}`);
        const homes = await raw<{ id: string; home: string | null; tags: string[] }[]>`
          select n.id::text as id, n.home_ws::text as home, n.tags
            from nodes n where n.id in (${shot.a}, ${shot.b})`;
        const priv = await raw<{ login: string; ws: string }[]>`
          select login_id::text as login, workspace_id::text as ws from private_workspaces
           where login_id in (${L.a}, ${L.b})`;
        const privOf = (who: Who) => priv.find((p) => p.login === L[who])?.ws;
        expect(privOf('a'), 'A has a private workspace').toBeTruthy();
        expect(privOf('b'), 'B has a private workspace').toBeTruthy();
        expect(privOf('a')).not.toBe(privOf('b'));
        for (const who of ['a', 'b'] as const) {
          const row = homes.find((h) => h.id === shot[who]);
          expect(row?.home, `${who}'s screenshot home`).toBe(privOf(who));
          expect(row?.tags).toContain('screenshot');
        }
        expect(await loginsOf([shot.a, shot.b])).toEqual({
          [shot.a]: L.a,
          [shot.b]: L.b,
        });
        expect(m.takeActorMisses()).toEqual([]);
      }, 120_000);

      it('each Admin user saves its own into Auto-filed / Screenshots in Admin, private to its login', async () => {
        await setMode(mode);
        shot.x = await shoot(mode, 'x', `${tag} x ${mode}`);
        shot.y = await shoot(mode, 'y', `${tag} y ${mode}`);
        const rows = await raw<{ id: string; home: string | null; path: string; tags: string[] }[]>`
          select n.id::text as id, n.home_ws::text as home, n.path::text as path, n.tags
            from nodes n where n.id in (${shot.x}, ${shot.y})`;
        for (const who of ADMINS) {
          const row = rows.find((r) => r.id === shot[who]);
          expect(row?.home, `${who}'s screenshot home`).toBe(ws.admin);
          expect(row?.path, `${who}'s screenshot folder`).toMatch(
            /^files\.auto_filed\.screenshots\.\d{4}_\d{2}$/,
          );
          expect(row?.tags).toContain('screenshot');
        }
        // One folder for both: the one they both see.
        expect(rows[0]!.path).toBe(rows[1]!.path);
        shotFolder = rows[0]!.path;
        expect(await loginsOf([shot.x, shot.y])).toEqual({
          [shot.x]: L.x,
          [shot.y]: L.y,
        });
        expect(m.takeActorMisses()).toEqual([]);
      }, 120_000);

      it("B fetches A's by no route: the same 404 as an id that does not exist", async () => {
        await setMode(mode);
        const missing = randomUUID();
        for (const q of ['', '?raw=1', '?thumb=1']) {
          const theirs = await route(
            `${mode} b GET a's file${q}`,
            'b',
            'GET',
            `/api/files/files/${shot.a}${q}`,
          );
          const none = await route(
            `${mode} b GET missing file${q}`,
            'b',
            'GET',
            `/api/files/files/${missing}${q}`,
          );
          expect(theirs.status, `b GET a's${q}`).toBe(404);
          expect(theirs.json, `b GET a's${q}`).toEqual(none.json);
          expect(theirs.bytes.includes(PNG.subarray(8)), `b GET a's${q}: no bytes`).toBe(false);
        }
        expect(m.takeActorMisses()).toEqual([]);
      }, 120_000);

      it("no list route shows B A's; B's lists hold its own", async () => {
        await setMode(mode);
        const recent = await listedBy(
          `${mode} b recent`,
          'b',
          '/api/files/files?recent=1&limit=200',
        );
        const top = await listedBy(`${mode} b files root`, 'b', '/api/files/files?parent=files');
        expect(recent, "b's recent").not.toContain(shot.a);
        expect(top, "b's files root").not.toContain(shot.a);
        expect(recent, "b's recent holds its own").toContain(shot.b);
        expect(top, "b's files root holds its own").toContain(shot.b);
        expect(m.takeActorMisses()).toEqual([]);
      }, 120_000);

      it('A still fetches and lists its own, and not B’s', async () => {
        await setMode(mode);
        const detail = await route(
          `${mode} a GET own file`,
          'a',
          'GET',
          `/api/files/files/${shot.a}`,
        );
        expect(detail.status).toBe(200);
        expect((detail.json.file as { id?: string } | undefined)?.id).toBe(shot.a);
        const bytes = await route(
          `${mode} a GET own file raw`,
          'a',
          'GET',
          `/api/files/files/${shot.a}?raw=1`,
        );
        expect(bytes.status).toBe(200);
        expect(bytes.bytes.equals(PNG)).toBe(true);
        const theirs = await route(
          `${mode} a GET b's file`,
          'a',
          'GET',
          `/api/files/files/${shot.b}`,
        );
        expect(theirs.status).toBe(404);
        const recent = await listedBy(
          `${mode} a recent`,
          'a',
          '/api/files/files?recent=1&limit=200',
        );
        const top = await listedBy(`${mode} a files root`, 'a', '/api/files/files?parent=files');
        expect(recent).toContain(shot.a);
        expect(top).toContain(shot.a);
        expect(recent).not.toContain(shot.b);
        expect(top).not.toContain(shot.b);
        expect(m.takeActorMisses()).toEqual([]);
      }, 120_000);

      it("the MCP tool screenshots: B neither lists nor shows A's", async () => {
        await setMode(mode);
        const list = await viaMcp('b', { limit: 50 });
        recorded.push(`${mode} mcp b list: ${list.ok} ${list.text.slice(0, 160)}`);
        expect(list.ok, list.text).toBe(true);
        expect(mcpIds(list)).not.toContain(shot.a);
        expect(mcpIds(list)).toContain(shot.b);
        expect(list.text).not.toContain(`${tag} a`);

        const show = await viaMcp('b', { id: shot.a });
        const none = await viaMcp('b', { id: randomUUID() });
        recorded.push(`${mode} mcp b show a's: ${show.ok} ${show.text.slice(0, 160)}`);
        expect(show.ok).toBe(false);
        expect(show.text).toBe('screenshot not found');
        expect(show.text).toBe(none.text);
        expect(show.images).toEqual([]);
        expect(m.takeActorMisses()).toEqual([]);
      }, 120_000);

      it('the MCP tool screenshots: A lists and shows its own, and not B’s', async () => {
        await setMode(mode);
        const list = await viaMcp('a', { limit: 50 });
        recorded.push(`${mode} mcp a list: ${list.ok} ${list.text.slice(0, 160)}`);
        expect(list.ok, list.text).toBe(true);
        expect(mcpIds(list)).toContain(shot.a);
        expect(mcpIds(list)).not.toContain(shot.b);

        const show = await viaMcp('a', { id: shot.a });
        recorded.push(`${mode} mcp a show own: ${show.ok} ${show.text.slice(0, 160)}`);
        expect(show.ok, show.text).toBe(true);
        expect(show.out.screenshot).toMatchObject({
          id: shot.a,
          mimeType: 'image/png',
          note: `${tag} a ${mode}`,
        });
        expect(show.images).toHaveLength(1);
        expect(Buffer.from(show.images[0]!.data ?? '', 'base64').equals(PNG)).toBe(true);

        const theirs = await viaMcp('a', { id: shot.b });
        expect(theirs.ok).toBe(false);
        expect(theirs.text).toBe('screenshot not found');
        expect(m.takeActorMisses()).toEqual([]);
      }, 120_000);

      it("Y fetches X's by no route; neither Recent nor the Screenshots folder lists it for Y", async () => {
        await setMode(mode);
        await fetchedByNoRoute(mode, 'y', 'x', shot.x);
        const folder = `/api/files/files?parent=${encodeURIComponent(shotFolder)}`;
        const recent = await listedBy(
          `${mode} y recent`,
          'y',
          '/api/files/files?recent=1&limit=200',
        );
        const inFolder = await listedBy(`${mode} y screenshots folder`, 'y', folder);
        expect(recent, "y's recent").not.toContain(shot.x);
        expect(inFolder, "y's screenshots folder").not.toContain(shot.x);
        expect(recent, "y's recent holds its own").toContain(shot.y);
        expect(inFolder, "y's screenshots folder holds its own").toContain(shot.y);
        // And the other way: X reads its own, never Y's.
        await fetchedByNoRoute(mode, 'x', 'y', shot.y);
        const own = await route(
          `${mode} x GET own file raw`,
          'x',
          'GET',
          `/api/files/files/${shot.x}?raw=1`,
        );
        expect(own.status).toBe(200);
        expect(own.bytes.equals(PNG)).toBe(true);
        const xFolder = await listedBy(`${mode} x screenshots folder`, 'x', folder);
        expect(xFolder).toContain(shot.x);
        expect(xFolder).not.toContain(shot.y);
        expect(m.takeActorMisses()).toEqual([]);
      }, 120_000);

      it("the MCP tool screenshots: Y neither lists nor shows X's; X lists and shows its own", async () => {
        await setMode(mode);
        const yList = await viaMcp('y', { limit: 50 });
        recorded.push(`${mode} mcp y list: ${yList.ok} ${yList.text.slice(0, 160)}`);
        expect(yList.ok, yList.text).toBe(true);
        expect(mcpIds(yList)).not.toContain(shot.x);
        expect(mcpIds(yList)).toContain(shot.y);
        expect(yList.text).not.toContain(`${tag} x`);
        const yShow = await viaMcp('y', { id: shot.x });
        const none = await viaMcp('y', { id: randomUUID() });
        recorded.push(`${mode} mcp y show x's: ${yShow.ok} ${yShow.text.slice(0, 160)}`);
        expect(yShow.ok).toBe(false);
        expect(yShow.text).toBe('screenshot not found');
        expect(yShow.text).toBe(none.text);
        expect(yShow.images).toEqual([]);

        const xList = await viaMcp('x', { limit: 50 });
        expect(xList.ok, xList.text).toBe(true);
        expect(mcpIds(xList)).toContain(shot.x);
        expect(mcpIds(xList)).not.toContain(shot.y);
        const xShow = await viaMcp('x', { id: shot.x });
        recorded.push(`${mode} mcp x show own: ${xShow.ok} ${xShow.text.slice(0, 160)}`);
        expect(xShow.ok, xShow.text).toBe(true);
        expect(xShow.out.screenshot).toMatchObject({ id: shot.x, note: `${tag} x ${mode}` });
        expect(xShow.images).toHaveLength(1);
        expect(Buffer.from(xShow.images[0]!.data ?? '', 'base64').equals(PNG)).toBe(true);
        expect(m.takeActorMisses()).toEqual([]);
      }, 120_000);

      it("an Admin user fetches, lists and shows no member's; a member no Admin user's", async () => {
        await setMode(mode);
        await fetchedByNoRoute(mode, 'x', 'a', shot.a);
        const recent = await listedBy(
          `${mode} x recent`,
          'x',
          '/api/files/files?recent=1&limit=200',
        );
        const top = await listedBy(`${mode} x files root`, 'x', '/api/files/files?parent=files');
        for (const who of ['a', 'b'] as const) {
          expect(recent, `x's recent: ${who}'s`).not.toContain(shot[who]);
          expect(top, `x's files root: ${who}'s`).not.toContain(shot[who]);
        }
        const list = await viaMcp('x', { limit: 50 });
        expect(list.ok, list.text).toBe(true);
        expect(mcpIds(list)).not.toContain(shot.a);
        expect(mcpIds(list)).not.toContain(shot.b);
        expect(list.text).not.toContain(`${tag} a`);
        const show = await viaMcp('x', { id: shot.a });
        recorded.push(`${mode} mcp x show a's: ${show.ok} ${show.text.slice(0, 160)}`);
        expect(show.ok).toBe(false);
        expect(show.text).toBe('screenshot not found');
        expect(show.images).toEqual([]);

        await fetchedByNoRoute(mode, 'a', 'x', shot.x);
        const aList = await viaMcp('a', { limit: 50 });
        expect(mcpIds(aList)).not.toContain(shot.x);
        expect(mcpIds(aList)).not.toContain(shot.y);
        const aShow = await viaMcp('a', { id: shot.x });
        expect(aShow.ok).toBe(false);
        expect(aShow.text).toBe('screenshot not found');
        expect(m.takeActorMisses()).toEqual([]);
      }, 120_000);

      it('a full-scope peer finds, reads and gets passages of no screenshot (H1)', async () => {
        await setMode(mode);
        await ensurePeer();
        const shots = [shot.a, shot.b, shot.x, shot.y];
        await passagesFor(shots);

        const list = await asPeer(`${mode} peer query`, 'POST', '/api/federation/query', {
          limit: 100,
        });
        expect(list.status).toBe(200);
        const listed = ((list.json.nodes ?? []) as Array<{ id: string }>).map((n) => n.id);
        expect(listed, 'the control').toContain(peer.nodeId);
        const files = await asPeer(`${mode} peer query files`, 'POST', '/api/federation/query', {
          types: ['file'],
          limit: 100,
        });
        expect(files.status).toBe(200);
        const ranked = await asPeer(`${mode} peer search`, 'POST', '/api/federation/query', {
          query: 'screenshot',
          limit: 100,
        });
        expect(ranked.status).toBe(200);
        for (const id of shots) {
          for (const r of [list, files, ranked]) {
            expect(((r.json.nodes ?? []) as Array<{ id: string }>).map((n) => n.id)).not.toContain(
              id,
            );
          }
          expect(list.text).not.toContain(id);
          expect(ranked.text).not.toContain(id);
        }
        expect(ranked.text).not.toContain(`${tag} a`);
        expect(ranked.text).not.toContain(`${tag} x`);

        const missing = await asPeer(
          `${mode} peer node missing`,
          'GET',
          `/api/federation/node/${randomUUID()}`,
        );
        expect(missing.status).toBe(404);
        for (const who of ['a', 'b', 'x', 'y'] as const) {
          const node = await asPeer(
            `${mode} peer node ${who}'s`,
            'GET',
            `/api/federation/node/${shot[who]}`,
          );
          expect(node.status, `peer reads ${who}'s`).toBe(404);
          expect(node.json).toEqual(missing.json);
        }
        const own = await asPeer(
          `${mode} peer node the control`,
          'GET',
          `/api/federation/node/${peer.nodeId}`,
        );
        expect(own.status).toBe(200);

        const chunks = await asPeer(`${mode} peer chunks`, 'POST', '/api/federation/chunks', {
          query: 'the screenshot',
          limit: 50,
        });
        expect(chunks.status).toBe(200);
        const passages = (chunks.json.chunks ?? []) as Array<{ nodeId: string }>;
        expect(
          passages.map((c) => c.nodeId),
          'the control',
        ).toContain(peer.nodeId);
        for (const id of shots) {
          expect(passages.map((c) => c.nodeId)).not.toContain(id);
          expect(chunks.text).not.toContain(`vision text of ${id}`);
        }
        await asSystemTx((tx) => tx`delete from content_chunks where node_id in ${tx(shots)}`);
        expect(m.takeActorMisses()).toEqual([]);
      }, 120_000);

      it("Y's diagnostics show none of X's or A's screenshots nor their facts; Y's own show", async () => {
        await setMode(mode);
        const word = `${tag}fact${mode}`;
        await asSystemTx(async (tx) => {
          for (const who of ['a', 'x', 'y'] as const) {
            await tx`insert into facts (owner_id, content, kind, source_node_id, login_id)
              values (${owner}, ${`${word} learned from ${who}'s screenshot`}, 'factual',
                      ${shot[who]}, ${L[who]})`;
            // A failed run of that login's (the overview's errors).
            await tx`insert into traces (owner_id, kind, status, error, login_id)
              values (${owner}, 'extractor_run', 'error', ${`${word} failed for ${who}`}, ${L[who]})`;
          }
        });

        const landed = await route(
          `${mode} y debug landed`,
          'y',
          'GET',
          '/api/debug/integrity/landed?types=file&limit=100',
        );
        expect(landed.status).toBe(200);
        const landedIds = ((landed.json.items ?? []) as Array<{ nodeId: string }>).map(
          (i) => i.nodeId,
        );
        expect(landedIds, "y's landed: its own").toContain(shot.y);
        for (const who of ['a', 'b', 'x'] as const) {
          expect(landedIds, `y's landed: ${who}'s`).not.toContain(shot[who]);
        }
        const xLanded = await route(
          `${mode} x debug landed`,
          'x',
          'GET',
          '/api/debug/integrity/landed?types=file&limit=100',
        );
        const xIds = ((xLanded.json.items ?? []) as Array<{ nodeId: string }>).map((i) => i.nodeId);
        expect(xIds).toContain(shot.x);
        expect(xIds).not.toContain(shot.y);

        // Y's delete of X's: not found (and X's is still there).
        const del = await route(
          `${mode} y debug landed delete x's`,
          'y',
          'POST',
          '/api/debug/integrity/landed/delete',
          { json: { nodeId: shot.x } },
        );
        expect(del.status).toBe(400);
        expect(del.json).toEqual({ error: 'node not found' });
        expect(await loginsOf([shot.x])).toEqual({ [shot.x]: L.x });

        const facts = await route(
          `${mode} y debug facts`,
          'y',
          'GET',
          `/api/debug/facts?q=${encodeURIComponent(word)}`,
        );
        expect(facts.status).toBe(200);
        const contents = ((facts.json.facts ?? []) as Array<{ content: string }>).map(
          (f) => f.content,
        );
        expect(contents, "y's facts: its own").toEqual([`${word} learned from y's screenshot`]);
        expect(facts.json.total).toBe(1);
        expect(facts.text).not.toContain(`${word} learned from x's`);
        expect(facts.text).not.toContain(`${word} learned from a's`);

        const audit = await route(
          `${mode} y debug audit`,
          'y',
          'GET',
          '/api/debug/integrity/audit',
        );
        expect(audit.status).toBe(200);
        for (const who of ['a', 'b', 'x'] as const) {
          expect(audit.text, `y's audit samples: ${who}'s`).not.toContain(shot[who]);
        }
        // The unembedded facts' samples carry a fact's text: Y's own shows
        // (the control), X's and A's do not.
        expect(audit.text, "y's audit: its own fact").toContain(`${word} learned from y's`);
        expect(audit.text, "y's audit: x's fact").not.toContain(`${word} learned from x's`);
        expect(audit.text, "y's audit: a's fact").not.toContain(`${word} learned from a's`);
        const overview = await route(`${mode} y debug overview`, 'y', 'GET', '/api/debug/overview');
        expect(overview.status).toBe(200);
        // The recent failures and top errors: Y's own run, not X's or A's.
        expect(overview.text, "y's overview: its own failure").toContain(`${word} failed for y`);
        expect(overview.text, "y's overview: x's").not.toContain(`${word} failed for x`);
        expect(overview.text, "y's overview: a's").not.toContain(`${word} failed for a`);
        expect(m.takeActorMisses()).toEqual([]);
      }, 120_000);

      it("Y's peer picker lists none of X's; Y's share of X's to the peer is refused (H1)", async () => {
        await setMode(mode);
        await ensurePeer();
        const pick = await route(
          `${mode} y peer picker`,
          'y',
          'GET',
          '/api/peers/nodes?q=screenshot',
        );
        expect(pick.status).toBe(200);
        const picked = ((pick.json.nodes ?? []) as Array<{ id: string }>).map((n) => n.id);
        for (const who of ['a', 'b', 'x', 'y'] as const) {
          expect(picked, `y's picker: ${who}'s`).not.toContain(shot[who]);
        }
        // The control: Y has the area, and shares the peer's own node.
        const control = await route(
          `${mode} y share the peer node`,
          'y',
          'POST',
          `/api/peers/${peer.id}/shares`,
          { json: { nodeId: peer.nodeId } },
        );
        expect(control.status).toBe(201);
        for (const who of ['x', 'a'] as const) {
          const share = await route(
            `${mode} y share ${who}'s`,
            'y',
            'POST',
            `/api/peers/${peer.id}/shares`,
            { json: { nodeId: shot[who] } },
          );
          expect(share.status, `y shares ${who}'s`).toBe(404);
        }
        // X may not hand its own to a peer either: a per-login row is no
        // login's to share (grantPeerShare does not know who asks).
        const xOwn = await route(
          `${mode} x share own`,
          'x',
          'POST',
          `/api/peers/${peer.id}/shares`,
          { json: { nodeId: shot.x } },
        );
        expect(xOwn.status).toBe(404);
        const shares = await raw<{ id: string }[]>`
          select node_id::text as id from peer_shares where peer_id = ${peer.id}`;
        for (const who of ['a', 'b', 'x', 'y'] as const) {
          expect(shares.map((r) => r.id)).not.toContain(shot[who]);
        }
        const listed = await route(
          `${mode} y peer shares`,
          'y',
          'GET',
          `/api/peers/${peer.id}/shares`,
        );
        expect(listed.status).toBe(200);
        // The Files count beside the category toggle counts no screenshot.
        const [files] = await raw<{ n: number }[]>`
          select count(*)::int as n from nodes
           where owner_id = ${owner} and type = 'file' and login_id is null`;
        expect((listed.json.typeCounts as Record<string, number>).file).toBe(files!.n);
        expect(m.takeActorMisses()).toEqual([]);
      }, 120_000);
    });
  }
});
