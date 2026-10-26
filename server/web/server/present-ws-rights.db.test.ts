/**
 * Present is a workspace content kind (owner rule 2026-10-26): a canvas is
 * read, made and changed by the same rights as a page or a table, and an
 * assistant or an MCP client of a login has exactly that login's rights.
 * On one migrated scratch database, switched to workspaces, with the actor
 * check and the edit check on, through the three ways in: an assistant
 * turn (dispatchTool in the turn scope, as the tool loop runs it), the HTTP
 * routes (runRoute: the full pipeline) and the one MCP surface (an OAuth
 * rw connection for the login, as /api/mcp serves it):
 *
 *  - a Moderator of W makes a canvas in W (MCP `workspace`, the route's
 *    `?ws=`, the W assistant's turn) and edits one W holds with no Write;
 *  - a plain user of W with Write on a canvas edits it; one without Write
 *    on it does not (no change, no crash);
 *  - nobody makes a canvas in a workspace it does not moderate: named,
 *    it is refused and nothing is made; unnamed, it lands in the caller's
 *    own private workspace (the turn and the route as for a page), and the
 *    MCP reply says where (`landedIn`);
 *  - a user's own canvas (its private workspace) is the user's to edit,
 *    on every way in, and another member who does not read it gets what a
 *    random uuid gets (the id aside).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/present-ws-rights.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@mantle/db';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

type Reply = { isError?: boolean; content?: { text?: string }[] };
const text = (r: unknown) =>
  ((r as Reply | null)?.content ?? []).map((p) => p.text ?? '').join(' ');

/** A canvas the load check takes: no outside URL, no CDN import. */
const canvas = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;

describe.skipIf(!URL)('Present rights follow the workspace roles on every way in', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ls: typeof import('@mantle/mcp-core');
  let presents: typeof import('@mantle/content/presents');
  let tools: typeof import('@mantle/tools');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `pws${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  /** A Moderator of W. */
  const mod = randomUUID();
  /** A plain user of W. */
  const user = randomUUID();
  /** A member with no seat in W. */
  const other = randomUUID();
  const ws = { admin: '', w: '', userOwn: '', otherOwn: '' };
  /** Homed in W: Write for its plain users, and without. */
  const cv = { write: '', noWrite: '' };
  const suiteMode = process.env.MANTLE_ACTOR_CHECK;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

  /** Make a canvas homed in `ws` alone, as the system. */
  const canvasIn = async (home: string, title: string, write: boolean) => {
    const row = await m.asSystem(
      () =>
        m.withCreateHome({ createWs: home, privateWs: null, quiet: true }, () =>
          presents.createPresent(owner, { source: canvas(`${tag} ${title}`), css: '' }),
        ),
      'test',
    );
    await m.withHeads([row.id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${row.id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${row.id}, ${home}, ${write}, true)`);
    });
    return row.id;
  };
  const titleOf = async (id: string) =>
    (await x<{ t: string }>(sql`select title as t from nodes where id = ${id}`))[0]?.t;
  /** The home of the newest canvas whose title holds `token`, or null. */
  const homeOf = async (token: string) =>
    (
      await x<{ home: string | null }>(sql`
        select g.workspace_id::text as home from nodes n
          left join item_grants g on g.node_id = n.id and g.is_home
         where n.type = 'present' and n.title ilike ${`%${token}%`}
         order by n.created_at desc limit 1`)
    )[0]?.home ?? null;
  const madeCount = async (token: string) =>
    (
      await x<{ n: number }>(sql`select count(*)::int as n from nodes
        where type = 'present' and title ilike ${`%${token}%`}`)
    )[0]!.n;
  /** `s` with every uuid as one token: a hidden item answers as a random
   *  one does, the id aside. */
  const noIds = (s: string) =>
    s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');

  // ── the assistant turn ────────────────────────────────────────────────
  const builtin = (slug: string) =>
    ({
      slug,
      name: slug,
      description: slug,
      handler: { kind: 'builtin', ref: slug },
      inputSchema: { type: 'object', properties: {} },
      requiresConfirm: false,
      externalAccess: null,
    }) as unknown as Tool;
  /** One tool call from the assistant turn of `turnWs` answering `login`. */
  const turn = (
    login: string,
    turnWs: string,
    modWs: string[],
    slug: string,
    input: Record<string, unknown>,
  ) =>
    m.withTurnScope(
      { kind: 'assistant', loginId: login, ws: [turnWs], modWs },
      () =>
        tools.dispatchTool(builtin(slug), input, {
          caller: tools.turnCaller(),
          ownerId: owner,
          surface: { kind: 'team', loginId: login },
        }),
      { writes: true },
    );
  const turnText = (r: unknown) => {
    const v = r as { ok: boolean; error?: string; output?: unknown };
    return v.ok ? JSON.stringify(v.output) : (v.error ?? '');
  };

  // ── the MCP surface ───────────────────────────────────────────────────
  const connect = async (loginId: string) => {
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const prepared = await ls.prepareCallerTools({
      role: 'member',
      anchorId: owner,
      loginId,
      via: 'oauth',
      write: true,
    });
    const server = new McpServer({ name: 'test', version: '0' });
    ls.registerPreparedTools(server, prepared);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: tag, version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    const listed = new Set((await c.listTools()).tools.map((t) => t.name));
    const call = async (name: string, args: Record<string, unknown>) => {
      expect(listed.has(name), `${name} is listed`).toBe(true);
      const r = (await c.callTool({ name, arguments: args }).catch((err: unknown) => ({
        isError: true,
        content: [{ text: `protocol: ${String(err)}` }],
      }))) as Reply;
      return { ok: !(r.isError ?? false), text: text(r) };
    };
    return { call, listed, close: () => c.close() };
  };

  // ── the routes ────────────────────────────────────────────────────────
  const route = async (login: string, method: string, url: string, body?: unknown) => {
    const res = await runRoute(login, method, url, body);
    return { status: res.status, text: await res.text() };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'present-ws-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'present-ws-rights-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    // No renderer, no outside: a save says it was not drawn.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline', { status: 503 })),
    );
    m = await import('@mantle/db');
    ls = await import('@mantle/mcp-core');
    presents = await import('@mantle/content/presents');
    tools = await import('@mantle/tools');
    runRoute = (await import('./run-route')).runRoute;
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${mod}, ${`${tag}-mod@example.invalid`}, 'x', false, 'member', 'Mod'),
      (${user}, ${`${tag}-u@example.invalid`}, 'x', false, 'member', 'User'),
      (${other}, ${`${tag}-x@example.invalid`}, 'x', false, 'member', 'Other')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    ws.admin = (
      await x<{ id: string }>(sql`select id::text as id from workspaces
        where owner_id = ${owner} and is_admin`)
    )[0]!.id;
    ws.w = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} W`}) returning id::text as id`)
    )[0]!.id;
    await su(sql`delete from workspace_users where workspace_id = ${ws.w}`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.w}, ${mod}, true), (${ws.w}, ${user}, false)`);
    const own = async (login: string) => {
      await x(
        sql`select "public"."mantle_ws_private_workspace"(set_config('mantle.scope_login', ${login}, true)::uuid)`,
      );
      return (
        await x<{ ws: string }>(sql`select workspace_id::text as ws from private_workspaces
          where login_id = ${login}`)
      )[0]!.ws;
    };
    ws.userOwn = await own(user);
    ws.otherOwn = await own(other);
    await own(mod);

    cv.write = await canvasIn(ws.w, 'write', true);
    cv.noWrite = await canvasIn(ws.w, 'no write', false);

    process.env.MANTLE_ACTOR_CHECK = 'on';
    await su(sql`select mantle_set_actor_check('on')`);
    await su(sql`select mantle_set_edit_check('on')`);
    m.takeActorMisses();
  }, 240_000);

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  describe('the assistant turn', () => {
    it("a Moderator's create in W's turn lands in W; it edits a canvas W holds with no Write", async () => {
      const token = `${tag}t${randomUUID().slice(0, 6)}`;
      const made = await turn(mod, ws.w, [ws.w], 'present_create', {
        title: token,
        source: canvas(token),
        look: false,
      });
      expect(made.ok, turnText(made)).toBe(true);
      expect(await homeOf(token)).toBe(ws.w);
      const edit = await turn(mod, ws.w, [ws.w], 'present_update', {
        id: cv.noWrite,
        title: `${tag} by mod`,
      });
      expect(edit.ok, turnText(edit)).toBe(true);
      expect(await titleOf(cv.noWrite)).toBe(`${tag} by mod`);
    });

    it("a plain user's create in W's turn lands in its own workspace; Write edits, no Write does not", async () => {
      const token = `${tag}t${randomUUID().slice(0, 6)}`;
      const made = await turn(user, ws.w, [], 'present_create', {
        title: token,
        source: canvas(token),
        look: false,
      });
      expect(made.ok, turnText(made)).toBe(true);
      expect(await homeOf(token)).toBe(ws.userOwn);
      const ok = await turn(user, ws.w, [], 'present_update', {
        id: cv.write,
        title: `${tag} turn write`,
      });
      expect(ok.ok, turnText(ok)).toBe(true);
      expect(await titleOf(cv.write)).toBe(`${tag} turn write`);
      const before = await titleOf(cv.noWrite);
      const refused = await turn(user, ws.w, [], 'present_update', {
        id: cv.noWrite,
        title: `${tag} turn refused`,
      });
      expect(refused.ok).toBe(false);
      expect(await titleOf(cv.noWrite)).toBe(before);
    });

    it("a user's own canvas: made and edited in its own workspace's turn; hidden from another member", async () => {
      const token = `${tag}t${randomUUID().slice(0, 6)}`;
      const made = await turn(user, ws.userOwn, [ws.userOwn], 'present_create', {
        title: token,
        source: canvas(token),
        look: false,
      });
      expect(made.ok, turnText(made)).toBe(true);
      expect(await homeOf(token)).toBe(ws.userOwn);
      const id = (made as { output: { id: string } }).output.id;
      const edit = await turn(user, ws.userOwn, [ws.userOwn], 'present_update', {
        id,
        title: `${token} edited`,
      });
      expect(edit.ok, turnText(edit)).toBe(true);
      expect(await titleOf(id)).toBe(`${token} edited`);

      const seen = await turn(other, ws.otherOwn, [ws.otherOwn], 'present_get', { id });
      const random = await turn(other, ws.otherOwn, [ws.otherOwn], 'present_get', {
        id: randomUUID(),
      });
      expect(seen.ok).toBe(false);
      expect(noIds(turnText(seen))).toBe(noIds(turnText(random)));
      const write = await turn(other, ws.otherOwn, [ws.otherOwn], 'present_update', {
        id,
        title: `${tag} other`,
      });
      const writeRandom = await turn(other, ws.otherOwn, [ws.otherOwn], 'present_update', {
        id: randomUUID(),
        title: `${tag} other`,
      });
      expect(write.ok).toBe(false);
      expect(noIds(turnText(write))).toBe(noIds(turnText(writeRandom)));
      expect(await titleOf(id)).toBe(`${token} edited`);
      expect(m.takeActorMisses()).toEqual([]);
    });
  });

  describe('the routes', () => {
    it('a Moderator makes a canvas in W with ?ws=; a plain user is refused there, and lands in its own without', async () => {
      const t1 = `${tag}r${randomUUID().slice(0, 6)}`;
      const made = await route(mod, 'POST', `/api/presents?ws=${ws.w}`, {
        title: t1,
        source: canvas(t1),
      });
      expect(made.status, made.text).toBe(201);
      expect(await homeOf(t1)).toBe(ws.w);

      const t2 = `${tag}r${randomUUID().slice(0, 6)}`;
      const refused = await route(user, 'POST', `/api/presents?ws=${ws.w}`, {
        title: t2,
        source: canvas(t2),
      });
      expect(refused.status, refused.text).toBeGreaterThanOrEqual(400);
      expect(refused.status, refused.text).toBeLessThan(500);
      expect(await madeCount(t2)).toBe(0);

      const t3 = `${tag}r${randomUUID().slice(0, 6)}`;
      const own = await route(user, 'POST', '/api/presents', { title: t3, source: canvas(t3) });
      expect(own.status, own.text).toBe(201);
      expect(await homeOf(t3)).toBe(ws.userOwn);
    });

    it('Write edits, no Write does not, a Moderator does; an own canvas is hidden from another member', async () => {
      const ok = await route(user, 'PATCH', `/api/presents/${cv.write}`, {
        title: `${tag} route write`,
      });
      expect(ok.status, ok.text).toBe(200);
      expect(await titleOf(cv.write)).toBe(`${tag} route write`);
      const before = await titleOf(cv.noWrite);
      const refused = await route(user, 'PATCH', `/api/presents/${cv.noWrite}`, {
        title: `${tag} route refused`,
      });
      expect([403, 404], refused.text).toContain(refused.status);
      expect(await titleOf(cv.noWrite)).toBe(before);
      const modEdit = await route(mod, 'PATCH', `/api/presents/${cv.noWrite}`, {
        title: `${tag} route mod`,
      });
      expect(modEdit.status, modEdit.text).toBe(200);

      const t = `${tag}r${randomUUID().slice(0, 6)}`;
      const made = await route(user, 'POST', '/api/presents', { title: t, source: canvas(t) });
      expect(made.status, made.text).toBe(201);
      const id = (JSON.parse(made.text) as { present: { id: string } }).present.id;
      const edit = await route(user, 'PATCH', `/api/presents/${id}`, { title: `${t} edited` });
      expect(edit.status, edit.text).toBe(200);
      for (const [method, body] of [
        ['GET', undefined],
        ['PATCH', { title: `${tag} other` }],
      ] as const) {
        const hidden = await route(other, method, `/api/presents/${id}`, body);
        const random = await route(other, method, `/api/presents/${randomUUID()}`, body);
        expect(hidden.status, `${method} ${hidden.text}`).toBe(random.status);
        expect(noIds(hidden.text)).toBe(noIds(random.text));
      }
      expect(await titleOf(id)).toBe(`${t} edited`);
      expect(m.takeActorMisses()).toEqual([]);
    });
  });

  describe('the MCP surface', () => {
    it('lists the canvas reads and writes for a member rw login, present_delete aside as for pages', async () => {
      const c = await connect(user);
      try {
        for (const slug of [
          'present_list',
          'present_get',
          'present_render',
          'present_revisions',
          'present_create',
          'present_update',
          'present_restore',
          'present_export',
        ]) {
          expect(c.listed.has(slug), slug).toBe(true);
        }
      } finally {
        await c.close();
      }
    });

    it('a Moderator makes a canvas in W and the reply says where; a plain user is refused there', async () => {
      const cm = await connect(mod);
      const cu = await connect(user);
      try {
        const t1 = `${tag}m${randomUUID().slice(0, 6)}`;
        const made = await cm.call('present_create', {
          title: t1,
          source: canvas(t1),
          look: false,
          workspace: ws.w,
        });
        expect(made.ok, made.text).toBe(true);
        expect(await homeOf(t1)).toBe(ws.w);
        expect(made.text).toContain(`${tag} W`);

        const t2 = `${tag}m${randomUUID().slice(0, 6)}`;
        const refused = await cu.call('present_create', {
          title: t2,
          source: canvas(t2),
          look: false,
          workspace: ws.w,
        });
        expect(refused.ok, refused.text).toBe(false);
        expect(await madeCount(t2)).toBe(0);

        const t3 = `${tag}m${randomUUID().slice(0, 6)}`;
        const own = await cu.call('present_create', {
          title: t3,
          source: canvas(t3),
          look: false,
        });
        expect(own.ok, own.text).toBe(true);
        expect(await homeOf(t3)).toBe(ws.userOwn);
        expect(own.text).toContain('landedIn');
      } finally {
        await cm.close();
        await cu.close();
      }
    });

    it('Write edits, no Write does not, a Moderator does; an own canvas is hidden from another member', async () => {
      const cm = await connect(mod);
      const cu = await connect(user);
      const co = await connect(other);
      try {
        const ok = await cu.call('present_update', { id: cv.write, title: `${tag} mcp write` });
        expect(ok.ok, ok.text).toBe(true);
        expect(await titleOf(cv.write)).toBe(`${tag} mcp write`);
        const before = await titleOf(cv.noWrite);
        const refused = await cu.call('present_update', {
          id: cv.noWrite,
          title: `${tag} mcp refused`,
        });
        expect(refused.ok, refused.text).toBe(false);
        expect(await titleOf(cv.noWrite)).toBe(before);
        const modEdit = await cm.call('present_update', {
          id: cv.noWrite,
          title: `${tag} mcp mod`,
        });
        expect(modEdit.ok, modEdit.text).toBe(true);

        const t = `${tag}m${randomUUID().slice(0, 6)}`;
        const made = await cu.call('present_create', { title: t, source: canvas(t), look: false });
        expect(made.ok, made.text).toBe(true);
        const id = (JSON.parse(made.text) as { id: string }).id;
        const edit = await cu.call('present_update', { id, title: `${t} edited` });
        expect(edit.ok, edit.text).toBe(true);
        for (const [slug, args] of [
          ['present_get', {}],
          ['present_update', { title: `${tag} other` }],
        ] as const) {
          const hidden = await co.call(slug, { id, ...args });
          const random = await co.call(slug, { id: randomUUID(), ...args });
          expect(hidden.ok).toBe(false);
          expect(noIds(hidden.text), slug).toBe(noIds(random.text));
        }
        expect(await titleOf(id)).toBe(`${t} edited`);
        expect(m.takeActorMisses()).toEqual([]);
      } finally {
        await cm.close();
        await cu.close();
        await co.close();
      }
    });
  });
});
