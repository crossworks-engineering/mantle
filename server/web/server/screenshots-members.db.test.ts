/**
 * Area screenshots between two members (docs/files.md, "Screenshots"): one
 * member never lists or fetches another's. On a migrated scratch database
 * switched to workspaces, in warn and in on (the actor and the edit check
 * together, as on the fleet), with two plain members A and B who share a
 * workspace W (so they do read some of the same things):
 *
 *  - each saves a screenshot through the full HTTP pipeline (runRoute,
 *    POST /api/screenshots, multipart): 201, landed in its own private
 *    workspace;
 *  - the routes the feature reads by: B fetches A's by id (the detail,
 *    `?raw=1` the bytes, `?thumb=1`) as the same 404 as an id that does not
 *    exist, and neither Recent (`?recent=1`) nor the Files root
 *    (`?parent=files`) lists it for B; A fetches and lists its own;
 *  - the MCP tool `screenshots` on each login's own surface
 *    (prepareCallerTools, an OAuth connection): B's list holds its own and
 *    not A's, and B's show of A's id is refused as "screenshot not found";
 *    A's list holds its own and not B's, and A's show returns its metadata
 *    and the picture.
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
type Who = 'a' | 'b';
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

describe.skipIf(!DB_URL)("area screenshots: a member never lists or fetches another's", () => {
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
  const L: Record<Who, string> = { a: randomUUID(), b: randomUUID() };
  const ws = { admin: '', w: '' };
  const recorded: string[] = [];

  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:shotm', fn) as Promise<T>;

  const setMode = async (mode: Mode) => {
    await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
    await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
    process.env.MANTLE_ACTOR_CHECK = mode;
    actorMode.noteBoxActorCheckMode(mode);
    expect(m.actorCheckMode()).toBe(mode);
  };

  /** One request through the full pipeline as `who`. */
  const route = async (name: string, who: Who, method: string, url: string, rawBody?: BodyInit) => {
    const res = await runRoute(L[who], method, url, undefined, rawBody ? { rawBody } : {});
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
    return { status: res.status, json, bytes, type };
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
      role: 'member' as const,
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

    await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'Owner'),
             (${L.a}, ${`${tag}-a@example.invalid`}, 'x', false, 'member', 'Member A'),
             (${L.b}, ${`${tag}-b@example.invalid`}, 'x', false, 'member', 'Member B')`;
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
      const shot: Record<Who, string> = { a: '', b: '' };

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
    });
  }
});
