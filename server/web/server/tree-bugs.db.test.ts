/**
 * The tree bugs of the A8 tool matrix (docs/_archive/tree-bugs-handover.md):
 *
 *  - S11a-6a: Write on a folder renames it (the owner's rule, 2026-10-18;
 *    migration 0305). A Write grant's member renames a notes folder
 *    (tree_folder_update) and a Files folder (folder_rename), and what the
 *    folder holds moves with it, rows the member does not read too. Its
 *    move, its delete and a system folder's rename stay a Moderator's of its
 *    home; in SQL on the write role, the subtree rewrite and the move check
 *    ask manage of a move and of a system folder, edit of a rename.
 *  - S11a-5: a member's move of an item into a folder of another workspace
 *    (page_move, tree_item_move) is made and answers ok: the share
 *    follow-up runs as the named system step 'tree-refold', not in the
 *    caller's scope (which may not read node_embeds). The move's own rule
 *    is unchanged: a Write grant's member (no Moderator) may not move it.
 *
 * Member negatives of each (plan rule 5): the outsider, the read grant's
 * member and a member with Write on a sibling item are refused, nothing
 * changes, and a caller that does not read the item gets a random uuid's
 * answer, byte for byte (the id aside).
 *
 * On a migrated scratch database, in check mode warn and on (the actor and
 * the edit check together, as the fleet runs them), through the login's MCP
 * surface (prepareCallerTools, an OAuth connection) and an assistant turn
 * (dispatchTool, the turn caller).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/tree-bugs.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The migration of the fix (renumbered at merge if another lands first). */
const FIX_MIGRATION = '0305_folder_rename_write';

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

type Mode = 'warn' | 'on';
/** mod: a Moderator of H, R and T (homeModerator); wr: a user of W, which
 *  has Write (writeGrant); rd: a Moderator of R, Write off (readGrant);
 *  out: a Moderator of O, granted nothing; sib: a user of X, which has Write
 *  on a sibling item only. */
type Who = 'owner' | 'mod' | 'wr' | 'rd' | 'out' | 'sib';
type Outcome = { ok: boolean; text: string };
type Reply = { isError?: boolean; content?: { text?: string }[] };
type Grant = { ws: string; home?: true; write?: true };

describe.skipIf(!DB_URL)('the tree bugs: a Write rename, a cross-workspace move', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let w: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let ls: typeof import('@mantle/mcp-core');
  let rt: typeof import('@mantle/runtime/agent');
  let f: typeof import('@mantle/files');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let dir = '';
  const tag = `tbug${randomUUID().slice(0, 6)}`;
  const L: Record<Who, string> = {
    owner: randomUUID(),
    mod: randomUUID(),
    wr: randomUUID(),
    rd: randomUUID(),
    out: randomUUID(),
    sib: randomUUID(),
  };
  const ws = { admin: '', H: '', W: '', R: '', T: '', O: '', X: '' };
  const agentOf: Record<string, string> = {};
  const recorded: string[] = [];
  const n = () => randomUUID().slice(0, 8);
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  const owner = L.owner;

  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:tbug', fn) as Promise<T>;

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

  /** Give `id` exactly these grants (its subtree re-derives). */
  const grantsOn = async (id: string, grants: readonly Grant[]) => {
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id}`;
      for (const g of grants) {
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${id}, ${g.ws}, ${g.home === true}, ${g.write === true})`;
      }
    });
  };
  /** The fixture's shared grants: home H, W with Write, R with Write off. */
  const shared = (): Grant[] => [{ ws: ws.H, home: true }, { ws: ws.W, write: true }, { ws: ws.R }];

  const actorOf = (who: Who) =>
    who === 'owner' ? m.loginActor(owner, 'owner') : m.loginActor(L[who], 'rw');

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
      loginId: L[who],
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
      return {
        ok: !(r.isError ?? false),
        text: (r.content ?? []).map((x) => x.text ?? '').join(' '),
      };
    } catch (err) {
      return { ok: false, text: `THROWN ${(err as Error).message}` };
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
    try {
      const res = await m.runAsActor(actorOf(who), () =>
        rt.withAgentScope(
          { id: agentOf[wsId]!, ownerId: owner, workspaceId: wsId },
          () =>
            t.dispatchTool(row, input, {
              ownerId: owner,
              surface: { kind: 'web', loginId: L[who] } as never,
              caller: t.turnCaller(),
            }),
          { loginId: L[who] },
        ),
      );
      return {
        ok: res.ok,
        text: res.ok ? JSON.stringify(res.output ?? '') : String(res.error ?? ''),
      };
    } catch (err) {
      return { ok: false, text: `THROWN ${(err as Error).message}` };
    }
  };

  /** The box's checks and the process's, together. */
  const setMode = async (mode: Mode) => {
    await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
    await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
    process.env.MANTLE_ACTOR_CHECK = mode;
    actorMode.noteBoxActorCheckMode(mode);
  };

  /** The owner's nodes as they stand: a refused write changes none. */
  const nodesState = async () =>
    (
      await raw<{ s: string }[]>`
        select coalesce(string_agg(id::text || ' ' || path::text || ' ' || coalesce(title, '')
                                   || ' ' || coalesce(home_ws::text, '-'), E'\n' order by id), '') as s
          from nodes where owner_id = ${owner}`
    )[0]!.s;
  const rowOf = async (id: string) =>
    (
      await raw<{ path: string; title: string; home: string | null }[]>`
        select path::text as path, title, home_ws::text as home from nodes where id = ${id}`
    )[0];

  const note1 = (mode: Mode, name: string, o: Outcome) =>
    recorded.push(
      `${mode} ${name}: ${o.ok ? 'ok' : 'refused'} ${o.text.slice(0, 160).replace(/\s+/g, ' ')}`,
    );

  /** A refusal: nothing changes; a caller that does not read the item gets
   *  a random uuid's answer, byte for byte (the id aside). */
  const refused = async (
    mode: Mode,
    name: string,
    call: (id: string) => Promise<Outcome>,
    id: string,
    reads: boolean,
  ) => {
    const before = await nodesState();
    const o = await call(id);
    note1(mode, name, o);
    expect(o.ok, `${name}: ${o.text}`).toBe(false);
    expect(o.text, `${name}: no database error`).not.toMatch(/could not run this request|THROWN/);
    expect(await nodesState(), `${name} changed a row`).toBe(before);
    if (!reads) {
      const rnd = randomUUID();
      const r = await call(rnd);
      expect(o.text.replaceAll(id, '<id>'), `${name}: a random uuid's answer`).toBe(
        r.text.replaceAll(rnd, '<id>'),
      );
    } else {
      expect(o.text, name).toMatch(/cannot change|not allowed|Write|Moderator|made by Mantle/i);
    }
  };

  const notesFolder = async (name: string, parent?: string) =>
    idIn(
      await sysTool('tree_folder_create', {
        kind: 'notes',
        name,
        ...(parent ? { parent_id: parent } : {}),
      }),
    );
  const pagesFolder = async (name: string) =>
    idIn(await sysTool('tree_folder_create', { kind: 'pages', name }));
  const noteIn = async (folder: string) => {
    const id = idIn(await sysTool('note_create', { title: `${tag} note ${n()}`, content: 'x' }));
    await sysTool('tree_item_move', {
      kind: 'notes',
      item_ids: [id],
      folder_id: folder,
      confirm: true,
    });
    return id;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'tree-bugs-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'tree-bugs-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the tree bugs test', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    ls = await import('@mantle/mcp-core');
    rt = await import('@mantle/runtime/agent');
    f = await import('@mantle/files');
    actorMode = await import('../../../packages/db/src/actor');
    const v = await import('@mantle/db/viewer');
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    w = postgres(
      v.viewerDatabaseUrl(
        scratch.url,
        'write',
        v.viewerRolePassword(process.env.MANTLE_MASTER_KEY, 'write'),
      ),
      { max: 1, prepare: false, onnotice: () => {} },
    );

    await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'Owner'),
             (${L.mod}, ${`${tag}-mod@example.invalid`}, 'x', false, 'member', 'Moderator'),
             (${L.wr}, ${`${tag}-wr@example.invalid`}, 'x', false, 'member', 'Writer'),
             (${L.rd}, ${`${tag}-rd@example.invalid`}, 'x', false, 'member', 'Reader'),
             (${L.out}, ${`${tag}-out@example.invalid`}, 'x', false, 'member', 'Outsider'),
             (${L.sib}, ${`${tag}-sib@example.invalid`}, 'x', false, 'member', 'Sibling')`;
    await raw`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    ws.admin = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
                                  where owner_id = ${owner} and is_admin`
    )[0]!.id;
    for (const key of ['H', 'W', 'R', 'T', 'O', 'X'] as const) {
      ws[key] = (
        await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
          values (${owner}, ${`${tag} ${key}`}) returning id::text as id`
      )[0]!.id;
    }
    const members = [L.mod, L.wr, L.rd, L.out, L.sib];
    await raw`delete from workspace_users where workspace_id = ${ws.admin}
               and login_id in ${raw(members)}`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.H}, ${L.mod}, true), (${ws.R}, ${L.mod}, true), (${ws.T}, ${L.mod}, true),
             (${ws.W}, ${L.wr}, false), (${ws.R}, ${L.rd}, true), (${ws.O}, ${L.out}, true),
             (${ws.X}, ${L.sib}, false)`;
    for (const [key, wsId] of Object.entries(ws)) {
      const id = randomUUID();
      agentOf[wsId] = id;
      await raw`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
        values (${id}, ${owner}, ${`${tag}-${key}`}, ${key}, 'fake/model', 'p',
                ${key === 'admin' ? 'assistant' : 'responder'}, ${wsId})`;
    }
    await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
    await sys(() => f.ensureFilesRootBranch(owner));
    const tree = await import('@mantle/content/tree');
    await sys(() => tree.ensureKindRoot(owner, 'notes'));
    await sys(() => tree.ensureKindRoot(owner, 'pages'));
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    console.log(['tree bugs, each cell:', ...recorded].join('\n  '));
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await w?.end();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the fix is one migration, its `when` above the one before it', async () => {
    const { readFileSync } = await import('node:fs');
    const journal = (
      JSON.parse(
        readFileSync(
          path.join(__dirname, '../../../packages/db/migrations/meta/_journal.json'),
          'utf8',
        ),
      ) as { entries: { tag: string; when: number }[] }
    ).entries;
    const at = journal.findIndex((e) => e.tag === FIX_MIGRATION);
    expect(at, FIX_MIGRATION).toBeGreaterThan(0);
    expect(journal[at]!.when).toBeGreaterThan(journal[at - 1]!.when);
  });

  for (const mode of ['warn', 'on'] as const) {
    describe(`check mode ${mode}`, () => {
      it("S11a-6a: a Write grant's member renames the folder; what it holds comes along", async () => {
        await setMode(mode);
        const g = await notesFolder(`${tag} rename ${n()}`);
        await grantsOn(g, shared());
        const child = await noteIn(g);
        // A row inside the member does not read (homed in O): filed, not
        // edited, it moves with the folder.
        const hidden = await noteIn(g);
        await grantsOn(hidden, [{ ws: ws.O, home: true }]);
        const name = `${tag} renamed ${n()}`;
        const o = await viaMcp('wr', 'tree_folder_update', { kind: 'notes', folder_id: g, name });
        note1(mode, 'tree_folder_update mcp wr rename', o);
        expect(o.ok, o.text).toBe(true);
        const after = (await rowOf(g))!;
        expect(after.title).toBe(name);
        expect((await rowOf(child))!.path).toBe(after.path);
        expect((await rowOf(hidden))!.path, 'the hidden row moved with it').toBe(after.path);
        // Through a turn of W too.
        const name2 = `${tag} again ${n()}`;
        const o2 = await viaTurn('wr', ws.W, 'tree_folder_update', {
          kind: 'notes',
          folder_id: g,
          name: name2,
        });
        note1(mode, 'tree_folder_update turn(W) wr rename', o2);
        expect(o2.ok, o2.text).toBe(true);
        expect((await rowOf(g))!.title).toBe(name2);
        expect((await rowOf(hidden))!.path).toBe((await rowOf(g))!.path);
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);

      it("S11a-6a: a Write grant's member renames a Files folder (folder_rename)", async () => {
        await setMode(mode);
        const fid = idIn(
          await sysTool('folder_create', { parent_path: 'files', slug: `${tag}-files-${n()}` }),
        );
        await grantsOn(fid, shared());
        const o = await viaMcp('wr', 'folder_rename', {
          folder_id: fid,
          new_name: `${tag} files renamed ${n()}`,
        });
        note1(mode, 'folder_rename mcp wr', o);
        expect(o.ok, o.text).toBe(true);
        expect((await rowOf(fid))!.path).toContain('renamed');
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);

      it('S11a-6a: the rename only; the member negatives refused', async () => {
        await setMode(mode);
        const g = await notesFolder(`${tag} neg ${n()}`);
        await grantsOn(g, shared());
        const dest = await notesFolder(`${tag} dest ${n()}`);
        await grantsOn(dest, shared());
        // A sibling the sib member has Write on, and nothing on g.
        const sibling = await notesFolder(`${tag} sibling ${n()}`);
        await grantsOn(sibling, [
          { ws: ws.H, home: true },
          { ws: ws.X, write: true },
        ]);
        const rename = (who: Who) => (id: string) =>
          viaMcp(who, 'tree_folder_update', { kind: 'notes', folder_id: id, name: `x ${n()}` });
        await refused(mode, 'rename mcp out', rename('out'), g, false);
        await refused(mode, 'rename mcp rd', rename('rd'), g, true);
        await refused(mode, 'rename mcp sib', rename('sib'), g, false);
        await refused(
          mode,
          'rename turn(X) sib',
          (id) =>
            viaTurn('sib', ws.X, 'tree_folder_update', {
              kind: 'notes',
              folder_id: id,
              name: `x ${n()}`,
            }),
          g,
          false,
        );
        // Write is not manage: no move, no delete.
        await refused(
          mode,
          'move mcp wr',
          (id) =>
            viaMcp('wr', 'tree_folder_update', {
              kind: 'notes',
              folder_id: id,
              parent_id: dest,
              confirm: true,
            }),
          g,
          true,
        );
        await refused(
          mode,
          'delete mcp wr',
          (id) =>
            viaMcp('wr', 'tree_folder_delete', { kind: 'notes', folder_id: id, confirm: true }),
          g,
          true,
        );
        // An Admin-homed folder: not read, a random uuid's answer.
        const adminOnly = await notesFolder(`${tag} admin ${n()}`);
        await grantsOn(adminOnly, [{ ws: ws.admin, home: true }]);
        await refused(mode, 'rename mcp wr admin-only', rename('wr'), adminOnly, false);
        // A system folder the member has Write on: its name is fixed.
        const system = await notesFolder(`${tag} system ${n()}`);
        await grantsOn(system, shared());
        await raw.begin(async (tx) => {
          await tx`select set_config('mantle.actor', 'system:test', true)`;
          await tx`update nodes set data = coalesce(data, '{}'::jsonb) || '{"system": true}'::jsonb
                    where id = ${system}`;
        });
        await refused(mode, 'rename mcp wr system', rename('wr'), system, true);
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);

      it('S11a-6a in SQL: the write role asks edit of a rename, manage of a move or a system folder', async () => {
        await setMode(mode);
        const g = await notesFolder(`${tag} sql ${n()}`);
        await grantsOn(g, shared());
        const dest = await notesFolder(`${tag} sqldest ${n()}`);
        await grantsOn(dest, shared());
        const system = await notesFolder(`${tag} sqlsys ${n()}`);
        await grantsOn(system, shared());
        await raw`update nodes set data = coalesce(data, '{}'::jsonb) || '{"system": true}'::jsonb
                   where id = ${system}`;
        const pathOf = async (id: string) => (await rowOf(id))!.path;
        const [gp, dp, sp] = [await pathOf(g), await pathOf(dest), await pathOf(system)];
        const label = (p: string) => p.split('.').at(-1)!;
        const parent = (p: string) => p.split('.').slice(0, -1).join('.');
        /** One statement on the write role in wr's scope (W). */
        const asWriter = (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
          w.begin(async (tx) => {
            await tx`select set_config('mantle.actor', ${`login:rw:${L.wr}`}, true),
                            set_config('mantle.write_mode', 'rw', true),
                            set_config('mantle.actor_check', ${mode}, true),
                            set_config('mantle.ws', ${`{${ws.W}}`}, true),
                            set_config('mantle.mod_ws', '{}', true),
                            set_config('mantle.login_id', ${L.wr}, true)`;
            await fn(tx);
          });
        const errOf = async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) => {
          try {
            await asWriter(fn);
            return 'ok';
          } catch (err) {
            const e = err as { code?: string; message?: string };
            return `${e.code} ${e.message}`;
          }
        };
        // A move (a new parent): manage, refused.
        expect(
          await errOf(
            (tx) =>
              tx`select mantle_subtree_rewrite(${owner}, ${gp}::ltree, ${`${dp}.${label(gp)}`}::ltree)`,
          ),
        ).toBe('42501 not allowed to move this item');
        // A system folder's rename: manage, refused.
        expect(
          await errOf(
            (tx) =>
              tx`select mantle_subtree_rewrite(${owner}, ${sp}::ltree, ${`${parent(sp)}.zz${n()}`}::ltree)`,
          ),
        ).toBe('42501 not allowed to move this item');
        // The move check on a direct path change: a move asks manage.
        expect(
          await errOf(async (tx) => {
            await tx`select mantle_lock_heads(array[${g}, ${dest}]::uuid[], 'update')`;
            await tx`update nodes set path = ${`${dp}.${label(gp)}`}::ltree where id = ${g}`;
          }),
        ).toMatch(/^42501 not allowed to move this item/);
        // A rename (the same parent) asks edit: Write on it is enough.
        expect(
          await errOf(async (tx) => {
            await tx`select mantle_lock_heads(array[${g}]::uuid[], 'update')`;
            await tx`select mantle_subtree_rewrite(${owner}, ${gp}::ltree, ${`${parent(gp)}.zz${n()}`}::ltree)`;
          }),
        ).toBe('ok');
        // The read grant's member (R, Write off): a rename is refused.
        expect(
          await errOf(async (tx) => {
            await tx`select set_config('mantle.ws', ${`{${ws.R}}`}, true),
                            set_config('mantle.mod_ws', ${`{${ws.R}}`}, true),
                            set_config('mantle.actor', ${`login:rw:${L.rd}`}, true),
                            set_config('mantle.login_id', ${L.rd}, true)`;
            const now = await pathOf(g);
            await tx`select mantle_subtree_rewrite(${owner}, ${now}::ltree, ${`${parent(now)}.zz${n()}`}::ltree)`;
          }),
        ).toBe('42501 not allowed to move this item');
      }, 300_000);

      it("S11a-5: a Moderator's move into another workspace's folder is made and answers ok", async () => {
        await setMode(mode);
        // The page sits in a folder homed in H (its grants), the destination
        // is homed in T: both moderated by mod.
        const from = await pagesFolder(`${tag} from ${n()}`);
        await grantsOn(from, shared());
        const to = await pagesFolder(`${tag} to ${n()}`);
        await grantsOn(to, [{ ws: ws.T, home: true }]);
        const page = idIn(await sysTool('page_create', { title: `${tag} page ${n()}` }));
        await sysTool('tree_item_move', {
          kind: 'pages',
          item_ids: [page],
          folder_id: from,
          confirm: true,
        });
        // A page that embeds it, so the follow-up has a walk to make.
        const embedder = idIn(
          await sysTool('page_create', {
            title: `${tag} embedder ${n()}`,
            markdown: `See [the page](/n/${page}).`,
          }),
        );
        await grantsOn(embedder, [{ ws: ws.H, home: true }]);
        const o = await viaMcp('mod', 'page_move', { id: page, folder_id: to, confirm: true });
        note1(mode, 'page_move mcp mod H to T', o);
        expect(o.ok, o.text).toBe(true);
        expect((await rowOf(page))!.path).toBe((await rowOf(to))!.path);
        expect((await rowOf(page))!.home).toBe(ws.T);

        // tree_item_move, a note this time.
        const nfrom = await notesFolder(`${tag} nfrom ${n()}`);
        await grantsOn(nfrom, shared());
        const nto = await notesFolder(`${tag} nto ${n()}`);
        await grantsOn(nto, [{ ws: ws.T, home: true }]);
        const item = await noteIn(nfrom);
        const o2 = await viaMcp('mod', 'tree_item_move', {
          kind: 'notes',
          item_ids: [item],
          folder_id: nto,
          confirm: true,
        });
        note1(mode, 'tree_item_move mcp mod H to T', o2);
        expect(o2.ok, o2.text).toBe(true);
        expect((await rowOf(item))!.path).toBe((await rowOf(nto))!.path);
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);

      it("S11a-5: the move's own rule stands; the member negatives refused", async () => {
        await setMode(mode);
        const nfrom = await notesFolder(`${tag} mfrom ${n()}`);
        await grantsOn(nfrom, shared());
        const nto = await notesFolder(`${tag} mto ${n()}`);
        await grantsOn(nto, [
          { ws: ws.T, home: true },
          { ws: ws.W, write: true },
        ]);
        const sibling = await noteIn(nfrom);
        await grantsOn(sibling, [
          { ws: ws.H, home: true },
          { ws: ws.X, write: true },
        ]);
        const item = await noteIn(nfrom);
        const move = (who: Who) => (id: string) =>
          viaMcp(who, 'tree_item_move', {
            kind: 'notes',
            item_ids: [id],
            folder_id: nto,
            confirm: true,
          });
        await refused(mode, 'move mcp out', move('out'), item, false);
        await refused(mode, 'move mcp rd', move('rd'), item, true);
        await refused(mode, 'move mcp sib', move('sib'), item, false);
        // Write on the item and on the destination is not manage of it.
        await refused(mode, 'move mcp wr', move('wr'), item, true);
        await refused(
          mode,
          'page_move mcp out',
          (id) => viaMcp('out', 'page_move', { id, folder_id: nto, confirm: true }),
          item,
          false,
        );
        expect(m.takeActorMisses()).toEqual([]);
      }, 300_000);
    });
  }
});
