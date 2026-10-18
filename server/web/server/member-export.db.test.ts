/**
 * Members export what they see (owner decision 2026-10-18), and a re-run of
 * an item's extraction needs edit of it.
 *
 * On a migrated scratch database, in check mode warn and on (the actor and
 * the edit check together, as a box switches them), through the product's
 * own ways in: the login's MCP surface (prepareCallerTools, an OAuth
 * connection) and an assistant turn of one workspace (dispatchTool, the
 * turn caller). Logins: the owner (an Admin user), a member (a Moderator of
 * H, a user of R) and a login in no workspace.
 *
 *  - app_export and sheet_build: an outsider is refused and no file is
 *    made; a member's export lands at the Files root in its create home (its
 *    private workspace, or the turn's workspace it moderates), it reads the
 *    file, and the reply names where it landed (landedIn); the file holds
 *    only what the member reads (an app's published code, no draft, no
 *    data; a sheet's own rows); an Admin user's lands in Auto-filed /
 *    Exports as before.
 *  - process_extraction: a reader of the item is refused and nothing is
 *    signalled; an editor is allowed. The signal is stubbed (resignalNode):
 *    no extractor and no model runs (cost safety).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/member-export.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

const signals = vi.hoisted(() => ({ ids: [] as string[] }));

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));
// The extractor's signal, stubbed: no model work starts (cost safety).
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resignalNode: vi.fn(async (id: string) => {
    signals.ids.push(id);
  }),
}));

type Mode = 'warn' | 'on';
type Who = 'owner' | 'member' | 'member2' | 'adminUser' | 'lone';
type Outcome = { ok: boolean; text: string; out: Record<string, unknown> };
type Reply = { isError?: boolean; content?: { text?: string }[] };

/** What a store root holds: every file, its size and bytes. */
function diskOf(root: string): string {
  if (!existsSync(root)) return '';
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!/-(wal|shm)$/.test(e.name)) {
        const h = createHash('md5').update(readFileSync(p)).digest('hex');
        out.push(`${path.relative(root, p)} ${statSync(p).size} ${h}`);
      }
    }
  };
  walk(root);
  return out.sort().join('\n');
}

describe.skipIf(!DB_URL)('members export what they see; extraction needs edit', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let ls: typeof import('@mantle/mcp-core');
  let rt: typeof import('@mantle/runtime/agent');
  let f: typeof import('@mantle/files');
  let pack: typeof import('@mantle/content/app-package');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let dir = '';
  const tag = `mexp${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const mem = randomUUID();
  const mem2 = randomUUID();
  const adminUser = randomUUID();
  const lone = randomUUID();
  const ws = { admin: '', H: '', R: '', O: '', U: '', M: '' };
  const agentOf: Record<string, string> = {};
  const recorded: string[] = [];
  const n = () => randomUUID().slice(0, 8);
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:mexp', fn) as Promise<T>;

  /** A builtin as the owner with no scope (the /api/v1 shape): the fixture's makes. */
  const sysTool = async (slug: string, input: Record<string, unknown>): Promise<unknown> => {
    const row = { slug, handler: { kind: 'builtin', ref: slug } } as never;
    const res = await sys(() =>
      t.dispatchTool(row, input, {
        ownerId: owner,
        surface: { kind: 'owner', via: 'api' },
        caller: t.apiV1Caller(),
      }),
    );
    if (!res.ok) throw new Error(`fixture ${slug}: ${String(res.error)}`);
    return res.output;
  };
  const idIn = (out: unknown): string => {
    const hit = UUID.exec(typeof out === 'string' ? out : JSON.stringify(out));
    if (!hit) throw new Error(`no id in ${JSON.stringify(out).slice(0, 200)}`);
    return hit[0];
  };

  /** Give `id` exactly one grant: homed in `home`. */
  const homeIn = async (id: string, home: string) => {
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id}`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${id}, ${home}, true, false)`;
    });
  };

  const loginOf = (who: Who) => ({ owner, member: mem, member2: mem2, adminUser, lone })[who];
  const actorOf = (who: Who) =>
    who === 'owner' ? m.loginActor(owner, 'owner') : m.loginActor(loginOf(who), 'rw');

  /** One call on the login's own MCP surface. */
  const viaMcp = async (
    who: Who,
    slug: string,
    input: Record<string, unknown>,
  ): Promise<Outcome> => {
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const server = new McpServer({ name: tag, version: '0' });
    const caller = {
      role: who === 'owner' ? ('admin' as const) : ('member' as const),
      anchorId: owner,
      loginId: loginOf(who),
      via: 'oauth' as const,
      write: true,
      oauthClientId: tag,
    };
    ls.registerPreparedTools(server, await ls.prepareCallerTools(caller as never));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: tag, version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const r = (await m.runAsActor(actorOf(who), () =>
        client.callTool({ name: slug, arguments: input }),
      )) as Reply;
      const text = (r.content ?? []).map((x) => x.text ?? '').join(' ');
      let out: Record<string, unknown> = {};
      try {
        out = JSON.parse(r.content?.[0]?.text ?? '') as Record<string, unknown>;
      } catch {
        // a refusal's words
      }
      return { ok: !(r.isError ?? false), text, out };
    } catch (err) {
      const msg = (err as Error).message;
      if (/Tool \S+ not found/.test(msg)) return { ok: false, text: `not listed: ${msg}`, out: {} };
      return { ok: false, text: `THROWN ${msg}`, out: {} };
    } finally {
      await client.close();
    }
  };

  /** One call in an assistant turn of workspace `wsId`, as `who`. */
  const viaTurn = async (
    who: Who,
    wsId: string,
    slug: string,
    input: Record<string, unknown>,
  ): Promise<Outcome> => {
    const row =
      (await sys(() => t.resolveTool(owner, slug))) ??
      ({ slug, handler: { kind: 'builtin', ref: slug } } as never);
    const login = loginOf(who);
    try {
      const res = await m.runAsActor(actorOf(who), () =>
        rt.withAgentScope(
          { id: agentOf[wsId]!, ownerId: owner, workspaceId: wsId },
          () =>
            t.dispatchTool(row, input, {
              ownerId: owner,
              surface: { kind: 'web', loginId: login } as never,
              caller: t.turnCaller(),
            }),
          { loginId: login },
        ),
      );
      return {
        ok: res.ok,
        text: res.ok ? JSON.stringify(res.output ?? '') : String(res.error ?? ''),
        out: res.ok ? ((res.output ?? {}) as Record<string, unknown>) : {},
      };
    } catch (err) {
      return { ok: false, text: `THROWN ${(err as Error).message}`, out: {} };
    }
  };

  /** The box's checks and the process's, together. */
  const setMode = async (mode: Mode) => {
    await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
    await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
    process.env.MANTLE_ACTOR_CHECK = mode;
    actorMode.noteBoxActorCheckMode(mode);
  };

  /** The owner's file nodes and the files store: a refused export changes neither. */
  const filesState = async () => {
    const [row] = await raw<{ c: number }[]>`
      select count(*)::int as c from nodes where owner_id = ${owner} and type = 'file'`;
    return `${row!.c}\n${diskOf(path.join(dir, 'files'))}`;
  };

  /** Where file `id` is, its home, and whether `who` reads it in its scope. */
  const fileFacts = async (id: string, who: Who) => {
    const [row] = await raw<{ path: string; home: string | null }[]>`
      select path::text as path, home_ws::text as home from nodes where id = ${id}`;
    const seen = await m.withViewer({ login: loginOf(who) }, async () => {
      const rows = (await m.db.execute(
        sql`select id from nodes where id = ${id}::uuid`,
      )) as unknown as unknown[];
      return rows.length > 0;
    });
    return { path: row?.path ?? null, home: row?.home ?? null, seen };
  };
  const privateWs = async (login: string) =>
    (
      await raw<{ ws: string }[]>`select workspace_id::text as ws from private_workspaces
                                   where login_id = ${login}`
    )[0]?.ws ?? null;
  const fileBytes = async (id: string) => {
    const got = await sys(() => f.readFileById({ ownerId: owner, fileId: id }));
    if (!got) throw new Error(`no file ${id}`);
    return got.bytes;
  };

  /** An app with a published version and a draft file, homed in `home`. */
  const app = async (home: string) => {
    const id = idIn(await sysTool('app_create', { name: `${tag} app ${n()}` }));
    await sysTool('app_file_write', {
      id,
      path: 'secret-draft.js',
      content: `export const draftOnly = '${tag}-draft';`,
    });
    await homeIn(id, home);
    return id;
  };
  const note = async (home: string) => {
    const id = idIn(await sysTool('note_create', { title: `${tag} note ${n()}`, content: 'x' }));
    await homeIn(id, home);
    return id;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'member-export-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'member-export-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the member export test', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    ls = await import('@mantle/mcp-core');
    rt = await import('@mantle/runtime/agent');
    f = await import('@mantle/files');
    pack = await import('@mantle/content/app-package');
    actorMode = await import('../../../packages/db/src/actor');
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'Owner'),
             (${mem}, ${`${tag}-member@example.invalid`}, 'x', false, 'member', 'Member'),
             (${mem2}, ${`${tag}-member2@example.invalid`}, 'x', false, 'member', 'Member 2'),
             (${adminUser}, ${`${tag}-aduser@example.invalid`}, 'x', false, 'member', 'Admin user'),
             (${lone}, ${`${tag}-lone@example.invalid`}, 'x', false, 'member', 'Lone')`;
    await raw`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    ws.admin = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
                                  where owner_id = ${owner} and is_admin`
    )[0]!.id;
    for (const key of ['H', 'R', 'O', 'U', 'M'] as const) {
      ws[key] = (
        await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
          values (${owner}, ${`${tag} ${key}`}) returning id::text as id`
      )[0]!.id;
    }
    await raw`delete from workspace_users u using workspaces w
               where w.id = u.workspace_id and not w.is_admin
                 and u.login_id in (${owner}, ${mem}, ${mem2}, ${adminUser}, ${lone})`;
    // An Admin user that is not its Moderator: it reads the Files root and
    // Auto-filed, and may change neither.
    await raw`delete from workspace_users where workspace_id = ${ws.admin}
               and login_id in (${mem}, ${mem2}, ${adminUser}, ${lone})`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.H}, ${mem}, true), (${ws.R}, ${mem}, false), (${ws.R}, ${mem2}, false),
             (${ws.admin}, ${adminUser}, false), (${ws.U}, ${owner}, false),
             (${ws.M}, ${owner}, true)`;
    for (const [key, wsId] of Object.entries(ws)) {
      const id = randomUUID();
      agentOf[wsId] = id;
      await raw`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
        values (${id}, ${owner}, ${`${tag}-${key}`}, ${key}, 'fake/model', 'p',
                ${key === 'admin' ? 'assistant' : 'responder'}, ${wsId})`;
    }
    await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
    await sys(() => f.ensureFilesRootBranch(owner));
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    console.log(['member export, each cell:', ...recorded].join('\n  '));
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const note1 = (mode: Mode, name: string, o: Outcome) =>
    recorded.push(
      `${mode} ${name}: ${o.ok ? 'ok' : 'refused'} ${o.text.slice(0, 160).replace(/\s+/g, ' ')}`,
    );

  /** A refused export: no file node, nothing on disk. */
  const refusedMakesNothing = async (
    mode: Mode,
    name: string,
    call: () => Promise<Outcome>,
    words: RegExp,
  ) => {
    const before = await filesState();
    const o = await call();
    note1(mode, name, o);
    expect(o.ok, `${name}: ${o.text}`).toBe(false);
    expect(o.text, name).toMatch(words);
    expect(await filesState(), `${name} made a file`).toBe(before);
  };

  /** An allowed member export: at the Files root, homed in `home`, read by
   *  the member, named in landedIn. */
  const landsFor = async (
    mode: Mode,
    name: string,
    o: Outcome,
    home: string,
    who: Who = 'member',
  ) => {
    note1(mode, name, o);
    expect(o.ok, `${name}: ${o.text}`).toBe(true);
    const fileId = String(o.out.file_id ?? '');
    expect(fileId, name).toMatch(UUID);
    const facts = await fileFacts(fileId, who);
    expect(facts.path, name).toBe('files');
    expect(facts.home, name).toBe(home);
    expect(facts.seen, `${name}: the member reads its export`).toBe(true);
    expect((o.out.landedIn as { id?: string } | undefined)?.id, `${name} landedIn`).toBe(home);
    return fileId;
  };

  for (const mode of ['warn', 'on'] as const) {
    describe(`check mode ${mode}`, () => {
      it('app_export: an outsider is refused and no file is made', async () => {
        await setMode(mode);
        const hidden = await app(ws.O);
        const words = /not found|not in your workspaces/i;
        await refusedMakesNothing(
          mode,
          'app_export mcp member/noRead',
          () => viaMcp('member', 'app_export', { id: hidden, with_data: false }),
          words,
        );
        await refusedMakesNothing(
          mode,
          'app_export turn(H) member/noRead',
          () => viaTurn('member', ws.H, 'app_export', { id: hidden, with_data: false }),
          words,
        );
        // A reader asks the data too (the default): that needs edit.
        const read = await app(ws.R);
        await refusedMakesNothing(
          mode,
          'app_export mcp member/read with data',
          () => viaMcp('member', 'app_export', { id: read }),
          /cannot change|not allowed|Write/i,
        );
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);

      it("app_export: a reader's export lands where it reads it, holding only what it reads", async () => {
        await setMode(mode);
        const read = await app(ws.R);
        const viaMcpOut = await viaMcp('member', 'app_export', { id: read, with_data: false });
        const own = await privateWs(mem);
        expect(own, 'the member has a private workspace').toBeTruthy();
        const fileId = await landsFor(mode, 'app_export mcp member/read', viaMcpOut, own!);
        const pkg = (await pack.openAppPackage(await fileBytes(fileId))).pkg;
        expect(pkg.data, 'no data: the member may not edit the app').toBeNull();
        expect(pkg.code.draft, 'no draft: a member does not read drafts').toBeNull();
        expect(JSON.stringify(pkg.code.source)).not.toContain(`${tag}-draft`);
        // The same in a turn of R (a user, no Moderator): its private workspace.
        const turnOut = await viaTurn('member', ws.R, 'app_export', {
          id: await app(ws.R),
          with_data: false,
        });
        await landsFor(mode, 'app_export turn(R) member/read', turnOut, own!);
        // A turn of H, which it moderates, on an app it reads there: H.
        const turnH = await viaTurn('member', ws.H, 'app_export', {
          id: await app(ws.H),
          with_data: false,
        });
        await landsFor(mode, 'app_export turn(H) member/moderator', turnH, ws.H);
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);

      it("app_export: an Admin user's export lands in Auto-filed / Exports", async () => {
        await setMode(mode);
        for (const [way, call] of [
          ['mcp', (id: string) => viaMcp('owner', 'app_export', { id, with_data: false })],
          [
            'turn(Admin)',
            (id: string) => viaTurn('owner', ws.admin, 'app_export', { id, with_data: false }),
          ],
        ] as const) {
          const o = await call(await app(ws.admin));
          note1(mode, `app_export ${way} owner`, o);
          expect(o.ok, `${way}: ${o.text}`).toBe(true);
          const facts = await fileFacts(String(o.out.file_id), 'owner');
          expect(facts.path, way).toMatch(/^files\.auto_filed\.exports\.\d{4}_\d{2}$/);
          expect(facts.home, way).toBe(ws.admin);
          expect((o.out.landedIn as { id?: string } | undefined)?.id, way).toBe(ws.admin);
        }
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);

      const sheet = (rows: Record<string, unknown>[]) => ({
        filename: `${tag}-${n()}.xlsx`,
        sheets: [
          {
            name: 'Quote',
            columns: [
              { key: 'item', header: 'Item' },
              { key: 'amount', header: 'Amount', type: 'number' },
            ],
            rows,
          },
        ],
      });

      it('sheet_build: a login in no workspace is refused and no file is made', async () => {
        await setMode(mode);
        await refusedMakesNothing(
          mode,
          'sheet_build mcp lone',
          () => viaMcp('lone', 'sheet_build', sheet([{ item: 'x', amount: 1 }])),
          /not listed|not in any workspace|Method not found/i,
        );
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);

      it("sheet_build: a member's sheet lands where it reads it, holding its own rows", async () => {
        await setMode(mode);
        const rows = [
          { item: `${tag}-widget`, amount: 12 },
          { item: `${tag}-gadget`, amount: 30 },
        ];
        const own = await privateWs(mem);
        const o = await viaMcp('member', 'sheet_build', sheet(rows));
        const home = own ?? (await privateWs(mem));
        const fileId = await landsFor(mode, 'sheet_build mcp member', o, home!);
        const text = await f.parseDocumentBytes(await fileBytes(fileId), 'xlsx');
        for (const r of rows) expect(text).toContain(r.item);
        expect(text.match(new RegExp(`${tag}-\\w+`, 'g'))?.sort()).toEqual(
          rows.map((r) => r.item).sort(),
        );
        // A turn of R (a user, no Moderator): its private workspace; of H: H.
        await landsFor(
          mode,
          'sheet_build turn(R) member',
          await viaTurn('member', ws.R, 'sheet_build', sheet(rows)),
          home!,
        );
        await landsFor(
          mode,
          'sheet_build turn(H) member',
          await viaTurn('member', ws.H, 'sheet_build', sheet(rows)),
          ws.H,
        );
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);

      it("sheet_build: an Admin user's sheet lands in Auto-filed / Exports", async () => {
        await setMode(mode);
        for (const [way, o] of [
          ['mcp', await viaMcp('owner', 'sheet_build', sheet([{ item: 'a', amount: 1 }]))],
          [
            'turn(Admin)',
            await viaTurn('owner', ws.admin, 'sheet_build', sheet([{ item: 'b', amount: 2 }])),
          ],
        ] as const) {
          note1(mode, `sheet_build ${way} owner`, o);
          expect(o.ok, `${way}: ${o.text}`).toBe(true);
          const facts = await fileFacts(String(o.out.file_id), 'owner');
          expect(facts.path, way).toMatch(/^files\.auto_filed\.exports\.\d{4}_\d{2}$/);
          expect(facts.home, way).toBe(ws.admin);
        }
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);

      it('a taken name: two members, and one member twice, each export lands under a free name', async () => {
        await setMode(mode);
        const name = `${tag}-clash-${mode}.xlsx`;
        const own = (await privateWs(mem))!;
        const a = await viaMcp('member', 'sheet_build', {
          ...sheet([{ item: 'a', amount: 1 }]),
          filename: name,
        });
        const aId = await landsFor(mode, 'sheet_build mcp member clash first', a, own);
        expect(a.out.filename).toBe(name);
        const [aRow] = await raw<{ sha: string }[]>`
          select data->>'sha256' as sha from nodes where id = ${aId}`;
        // Another member, same name, at the same Files root: its own file,
        // and nothing in the reply names the first one or where it is.
        const b = await viaMcp('member2', 'sheet_build', {
          ...sheet([{ item: 'b', amount: 2 }]),
          filename: name,
        });
        const own2 = (await privateWs(mem2))!;
        const bId = await landsFor(mode, 'sheet_build mcp member2 clash', b, own2, 'member2');
        expect(bId).not.toBe(aId);
        expect(b.out.filename).not.toBe(name);
        for (const leak of [aId, own, 'already exists']) expect(b.text).not.toContain(leak);
        expect((await fileFacts(aId, 'member2')).seen, 'B does not read A').toBe(false);
        // The first member again, same name: a new file, the first untouched.
        const again = await viaMcp('member', 'sheet_build', {
          ...sheet([{ item: 'c', amount: 3 }]),
          filename: name,
        });
        const againId = await landsFor(mode, 'sheet_build mcp member clash again', again, own);
        expect(new Set([aId, bId, againId]).size).toBe(3);
        const [aAfter] = await raw<{ sha: string }[]>`
          select data->>'sha256' as sha from nodes where id = ${aId}`;
        expect(aAfter!.sha, 'the first export is not overwritten').toBe(aRow!.sha);
        // An app's package (spooled) twice: both land, and no spool is left.
        const appId = await app(ws.R);
        const p1 = await viaMcp('member', 'app_export', { id: appId, with_data: false });
        const p2 = await viaMcp('member', 'app_export', { id: appId, with_data: false });
        await landsFor(mode, 'app_export mcp member twice (1)', p1, own);
        await landsFor(mode, 'app_export mcp member twice (2)', p2, own);
        expect(p2.out.file_id).not.toBe(p1.out.file_id);
        const spoolDir = path.join(dir, 'files', '.upload-spool');
        const parts = existsSync(spoolDir)
          ? readdirSync(spoolDir).filter((x) => x.endsWith('.part'))
          : [];
        expect(parts, 'no spooled package left').toEqual([]);
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);

      it('the owner in a turn of a workspace it is not Admin in: the top of Files, or refused', async () => {
        await setMode(mode);
        // A turn of M, which it moderates: M, at the Files root.
        const o = await viaTurn('owner', ws.M, 'sheet_build', sheet([{ item: 'm', amount: 1 }]));
        note1(mode, 'sheet_build turn(M) owner/moderator', o);
        expect(o.ok, o.text).toBe(true);
        const facts = await fileFacts(String(o.out.file_id), 'owner');
        expect(facts.path, 'not Auto-filed: M does not hold Admin').toBe('files');
        expect(facts.home).toBe(ws.M);
        expect((o.out.landedIn as { id?: string } | undefined)?.id).toBe(ws.M);
        // A turn of U, which it only uses: its create home is Admin, which
        // that turn may not write. Refused by the create check; nothing made.
        await refusedMakesNothing(
          mode,
          'sheet_build turn(U) owner/user',
          () => viaTurn('owner', ws.U, 'sheet_build', sheet([{ item: 'u', amount: 1 }])),
          /outside what your workspaces may change|cannot create items in that workspace/i,
        );
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);

      it('an Admin user that may not change the Files root: the top of Files', async () => {
        await setMode(mode);
        const u = await viaMcp('adminUser', 'sheet_build', sheet([{ item: 'u', amount: 1 }]));
        note1(mode, 'sheet_build mcp adminUser (no Moderator)', u);
        expect(u.ok, u.text).toBe(true);
        const uFacts = await fileFacts(String(u.out.file_id), 'adminUser');
        recorded.push(`${mode} sheet_build mcp adminUser: path ${uFacts.path} home ${uFacts.home}`);
        expect(uFacts.path, 'not Auto-filed: it may not change it').toBe('files');
        recorded.push(
          `${mode} adminUser private ${await privateWs(adminUser)} landedIn ${JSON.stringify(u.out.landedIn)}`,
        );
        expect(uFacts.seen).toBe(true);
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);

      it('process_extraction: a reader is refused and nothing is signalled; an editor is allowed', async () => {
        await setMode(mode);
        const readOnly = await note(ws.R);
        signals.ids.length = 0;
        const refused = await viaTurn('member', ws.R, 'process_extraction', {
          node_id: readOnly,
        });
        note1(mode, 'process_extraction turn(R) member/read', refused);
        expect(refused.ok, refused.text).toBe(false);
        expect(refused.text).toMatch(/cannot change this item/i);
        expect(signals.ids).toEqual([]);
        // A sweep in that turn signals none of the items it only reads.
        const sweep = await viaTurn('member', ws.R, 'process_extraction', {});
        note1(mode, 'process_extraction turn(R) member sweep', sweep);
        expect(sweep.ok, sweep.text).toBe(true);
        expect(signals.ids).not.toContain(readOnly);
        // A sweep in a turn of H (it moderates H) signals an eligible item
        // it may change there, and still none it only reads in R.
        const sweepable = await note(ws.H);
        signals.ids.length = 0;
        const sweepH = await viaTurn('member', ws.H, 'process_extraction', {});
        note1(mode, 'process_extraction turn(H) member sweep', sweepH);
        expect(sweepH.ok, sweepH.text).toBe(true);
        expect(signals.ids).toContain(sweepable);
        expect(signals.ids).not.toContain(readOnly);

        const editable = await note(ws.H);
        signals.ids.length = 0;
        const allowed = await viaTurn('member', ws.H, 'process_extraction', {
          node_id: editable,
        });
        note1(mode, 'process_extraction turn(H) member/moderator', allowed);
        expect(allowed.ok, allowed.text).toBe(true);
        expect(signals.ids).toEqual([editable]);
        // The owner, on its own MCP surface, as before.
        signals.ids.length = 0;
        const own = await note(ws.admin);
        const ownerRun = await viaMcp('owner', 'process_extraction', { node_id: own });
        note1(mode, 'process_extraction mcp owner', ownerRun);
        expect(ownerRun.ok, ownerRun.text).toBe(true);
        expect(signals.ids).toEqual([own]);
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);
    });
  }
});
