/**
 * Area screenshots and workspace rights (docs/files.md, "Screenshots"): a
 * screenshot is a plain upload to the top of Files in the workspace its
 * login is in (`?ws=`, the switcher's; else its own create home), so it has
 * that workspace's rights and no login of its own. On a migrated scratch
 * database switched to workspaces, in warn and in on (the actor and the
 * edit check together, as on the fleet), with members A (a Moderator of
 * W) and B (a plain user of W) in a shared workspace W, member C in
 * another workspace V, and two Admin users X and Y (Moderators of Admin):
 *
 *  - A saves one into W through the full HTTP pipeline (runRoute, POST
 *    /api/screenshots?ws=W, multipart): 201, landed in W, at the top of
 *    Files, tagged, no login_id;
 *  - B, who only reads W, asks for W too: it lands where B's normal Files
 *    upload with the same ?ws=W lands (POST /api/files/files, the same
 *    create-home rule: a workspace it does not moderate is as if none was
 *    named, so its own home), never in W;
 *  - B (in W) lists it (Recent, the Files root) and fetches it (the detail,
 *    `?raw=1` the bytes); C (not in W) fetches it by no route (the same 404
 *    as an id that does not exist) and lists it nowhere;
 *  - A saves one with no `?ws=`: its own create home (its private
 *    workspace), which B does not read;
 *  - X saves one with no `?ws=`: an Admin user's create home, which Y reads
 *    and no member does;
 *  - the MCP tool `screenshots` on each login's own surface (an OAuth
 *    connection) follows the same rights: B's list holds A's W one and
 *    shows it, C's neither lists nor shows it ("screenshot not found"), Y's
 *    holds X's, A's does not.
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

/** The database's or the runtime's own words: never in a reply. A missing
 *  object is matched by Postgres's own shape (`relation "x" does not
 *  exist`, quoted as JSON escapes it), never the bare words: the corpus
 *  audit's own help text says "when the role does not exist". */
const RAW =
  /Failed query|withSystemTx|runInSystemTx|SQLSTATE|DrizzleQueryError|PostgresError|drizzle-orm|permission denied for|violates|duplicate key|syntax error at or near|\b42P01\b|(?:relation|column|function|schema|type|role|database|table|sequence|operator|index)\s+\\?"[^"\\]+\\?"\s+does not exist|\n\s+at \S/i;

type Mode = 'warn' | 'on';
/** Members A and B (in W) and C (in V); Admin users X and Y. */
type Who = 'a' | 'b' | 'c' | 'x' | 'y';
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

describe.skipIf(!DB_URL)(
  'area screenshots: the workspace they land in decides who reads them',
  () => {
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
      c: randomUUID(),
      x: randomUUID(),
      y: randomUUID(),
    };
    const ws = { admin: '', w: '', v: '' };
    const recorded: string[] = [];

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

    /** Save a screenshot as `who` (POST /api/screenshots, `?ws=` when given):
     *  its file id and where it landed. */
    const shoot = async (mode: Mode, who: Who, note: string, inWs?: string) => {
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
        `${mode} ${who} POST /api/screenshots${inWs ? ' ?ws' : ''}`,
        who,
        'POST',
        `/api/screenshots${inWs ? `?ws=${inWs}` : ''}`,
        form,
      );
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      const id = String((r.json.file as { id?: string } | undefined)?.id ?? '');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      return { id, landedIn: (r.json.landedIn as { id?: string } | null)?.id ?? null };
    };

    /** Each node's home, path, login and tags, by id. */
    const rowsOf = async (ids: string[]) => {
      const rows = await raw<
        { id: string; home: string | null; path: string; login: string | null; tags: string[] }[]
      >`select id::text as id, home_ws::text as home, path::text as path,
             login_id::text as login, tags from nodes where id in ${raw(ids)}`;
      return Object.fromEntries(rows.map((r) => [r.id, r]));
    };

    /** `who` reads `id` by the detail and the bytes routes. */
    const fetches = async (mode: Mode, who: Who, id: string) => {
      const detail = await route(`${mode} ${who} GET file`, who, 'GET', `/api/files/files/${id}`);
      expect(detail.status, `${who} GET ${id}`).toBe(200);
      expect((detail.json.file as { id?: string } | undefined)?.id).toBe(id);
      const bytes = await route(
        `${mode} ${who} GET file raw`,
        who,
        'GET',
        `/api/files/files/${id}?raw=1`,
      );
      expect(bytes.status).toBe(200);
      expect(bytes.bytes.equals(PNG)).toBe(true);
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

      await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'Owner'),
             (${L.a}, ${`${tag}-a@example.invalid`}, 'x', false, 'member', 'Member A'),
             (${L.b}, ${`${tag}-b@example.invalid`}, 'x', false, 'member', 'Member B'),
             (${L.c}, ${`${tag}-c@example.invalid`}, 'x', false, 'member', 'Member C'),
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
      ws.v = (
        await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} V`}) returning id::text as id`
      )[0]!.id;
      // Three members, no seat in Admin: A a Moderator of W (it may make
      // items there, as its own upload would), B a plain user of W (it
      // reads W; its creates land in its own home), C a user of V.
      await raw`delete from workspace_users where workspace_id = ${ws.admin}
               and login_id in (${L.a}, ${L.b}, ${L.c})`;
      await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.w}, ${L.a}, true), (${ws.w}, ${L.b}, false), (${ws.v}, ${L.c}, false)`;
      // Two Admin users: Moderators of Admin.
      await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.admin}, ${L.x}, true), (${ws.admin}, ${L.y}, true)
      on conflict (workspace_id, login_id) do update set moderator = true`;
      await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
      await sys(() => f.ensureFilesRootBranch(owner));
      m.takeActorMisses();
    }, 300_000);

    afterAll(async () => {
      console.log(['screenshots and workspace rights, each call:', ...recorded].join('\n  '));
      process.env.MANTLE_ACTOR_CHECK = 'warn';
      vi.unstubAllGlobals();
      await raw?.end();
      await m?.closeDb();
      await scratch?.drop();
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    for (const mode of ['warn', 'on'] as const) {
      describe(`check mode ${mode}`, () => {
        /** A's in W, A's with no ?ws=, X's with no ?ws=. */
        const shot = { aw: '', aOwn: '', x: '' };

        it('A saves one into W (?ws=W): a plain file at the top of Files, home W, no login', async () => {
          await setMode(mode);
          const saved = await shoot(mode, 'a', `${tag} a in W ${mode}`, ws.w);
          shot.aw = saved.id;
          expect(saved.landedIn).toBe(ws.w);
          const row = (await rowsOf([shot.aw]))[shot.aw]!;
          expect(row.home).toBe(ws.w);
          expect(row.path).toBe('files');
          expect(row.login).toBeNull();
          expect(row.tags).toContain('screenshot');
          expect(m.takeActorMisses()).toEqual([]);
        }, 120_000);

        it('B, in W, lists and fetches it; C, not in W, fetches it by no route and lists it nowhere', async () => {
          await setMode(mode);
          await fetches(mode, 'b', shot.aw);
          const bRecent = await listedBy(
            `${mode} b recent`,
            'b',
            '/api/files/files?recent=1&limit=200',
          );
          const bTop = await listedBy(`${mode} b files root`, 'b', '/api/files/files?parent=files');
          expect(bRecent).toContain(shot.aw);
          expect(bTop).toContain(shot.aw);
          await fetchedByNoRoute(mode, 'c', 'a', shot.aw);
          const cRecent = await listedBy(
            `${mode} c recent`,
            'c',
            '/api/files/files?recent=1&limit=200',
          );
          const cTop = await listedBy(`${mode} c files root`, 'c', '/api/files/files?parent=files');
          expect(cRecent).not.toContain(shot.aw);
          expect(cTop).not.toContain(shot.aw);
          expect(m.takeActorMisses()).toEqual([]);
        }, 120_000);

        it("B, who only reads W, asks for W: it lands where B's own Files upload with ?ws=W lands", async () => {
          await setMode(mode);
          const saved = await shoot(mode, 'b', `${tag} b asks W ${mode}`, ws.w);
          // B's normal upload to the top of Files with the same ?ws=.
          const form = new FormData();
          form.append('parentPath', 'files');
          form.append(
            'file',
            new Blob([PNG], { type: 'image/png' }),
            `${tag}-b-upload-${mode}.png`,
          );
          const up = await route(
            `${mode} b POST /api/files/files ?ws`,
            'b',
            'POST',
            `/api/files/files?ws=${ws.w}`,
            form,
          );
          expect(up.status, JSON.stringify(up.json)).toBeLessThan(300);
          const uploadId = String((up.json.file as { id?: string } | undefined)?.id ?? '');
          const rows = await rowsOf([saved.id, uploadId]);
          // The same home by the same rule: not W (B does not moderate it).
          expect(rows[saved.id]!.home).toBe(rows[uploadId]!.home);
          expect(rows[saved.id]!.home).not.toBe(ws.w);
          expect(saved.landedIn).toBe(rows[saved.id]!.home);
          expect(rows[saved.id]!.login).toBeNull();
          // And the same readers: B reads it; A (in W) does not.
          await fetches(mode, 'b', saved.id);
          await fetchedByNoRoute(mode, 'a', 'b', saved.id);
          expect(m.takeActorMisses()).toEqual([]);
        }, 120_000);

        it('A saves one with no ?ws=: its own create home, which B does not read', async () => {
          await setMode(mode);
          const saved = await shoot(mode, 'a', `${tag} a own ${mode}`);
          shot.aOwn = saved.id;
          const row = (await rowsOf([shot.aOwn]))[shot.aOwn]!;
          expect(row.login).toBeNull();
          expect(row.home).not.toBe(ws.w);
          expect(saved.landedIn).toBe(row.home);
          await fetches(mode, 'a', shot.aOwn);
          await fetchedByNoRoute(mode, 'b', 'a', shot.aOwn);
          expect(m.takeActorMisses()).toEqual([]);
        }, 120_000);

        it("X saves one with no ?ws=: an Admin user's create home, which Y reads and no member does", async () => {
          await setMode(mode);
          const saved = await shoot(mode, 'x', `${tag} x ${mode}`);
          shot.x = saved.id;
          const row = (await rowsOf([shot.x]))[shot.x]!;
          expect(row.login).toBeNull();
          expect(row.path).toBe('files');
          expect(saved.landedIn).toBe(row.home);
          await fetches(mode, 'y', shot.x);
          for (const who of ['a', 'b', 'c'] as const)
            await fetchedByNoRoute(mode, who, 'x', shot.x);
          expect(m.takeActorMisses()).toEqual([]);
        }, 120_000);

        it('the MCP tool screenshots follows the same rights', async () => {
          await setMode(mode);
          const bList = await viaMcp('b', { limit: 50 });
          expect(bList.ok, bList.text).toBe(true);
          expect(mcpIds(bList)).toContain(shot.aw);
          expect(mcpIds(bList)).not.toContain(shot.aOwn);
          expect(mcpIds(bList)).not.toContain(shot.x);
          const bShow = await viaMcp('b', { id: shot.aw });
          expect(bShow.ok, bShow.text).toBe(true);
          expect(bShow.out.screenshot).toMatchObject({
            id: shot.aw,
            note: `${tag} a in W ${mode}`,
          });
          expect(bShow.images).toHaveLength(1);
          expect(Buffer.from(bShow.images[0]!.data ?? '', 'base64').equals(PNG)).toBe(true);

          const cList = await viaMcp('c', { limit: 50 });
          expect(cList.ok, cList.text).toBe(true);
          expect(mcpIds(cList)).not.toContain(shot.aw);
          const cShow = await viaMcp('c', { id: shot.aw });
          const none = await viaMcp('c', { id: randomUUID() });
          recorded.push(`${mode} mcp c show a's: ${cShow.ok} ${cShow.text.slice(0, 160)}`);
          expect(cShow.ok).toBe(false);
          expect(cShow.text).toBe('screenshot not found');
          expect(cShow.text).toBe(none.text);
          expect(cShow.images).toEqual([]);

          const yList = await viaMcp('y', { limit: 50 });
          expect(mcpIds(yList)).toContain(shot.x);
          const aList = await viaMcp('a', { limit: 50 });
          expect(mcpIds(aList)).toEqual(expect.arrayContaining([shot.aw, shot.aOwn]));
          expect(mcpIds(aList)).not.toContain(shot.x);
          const aShow = await viaMcp('a', { id: shot.x });
          expect(aShow.ok).toBe(false);
          expect(aShow.text).toBe('screenshot not found');
          expect(m.takeActorMisses()).toEqual([]);
        }, 120_000);
      });
    }
  },
);
