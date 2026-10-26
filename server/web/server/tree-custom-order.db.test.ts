/**
 * The tree's custom order (docs/folder-tree.md, "Custom order"): one order
 * for everyone, set by whoever may edit the folder (owner decision
 * 2026-10-26). An item's place is its `data.rank`, the one presentation key
 * (0281): the database lets edit of the item or of its folder change it, and
 * placeTreeItem asks Write on the folder (an Admin scope at the top level).
 *
 *  - a Write grant's member puts items of a folder in order
 *    (tree_item_place) and folders among their siblings (tree_folder_update
 *    `after`); the first place ranks the folder whole, later ones write the
 *    moved item only; `updated_at` never moves;
 *  - the folder lists in that order under `custom` (`ordered`), and an
 *    unordered folder lists in the kind's other sort, as before;
 *  - the read grant's member and the outsider are refused and nothing
 *    changes (the outsider's answer is a random uuid's, byte for byte, the
 *    id aside); a member may not order the top level, the owner may;
 *  - mayOrderFolder says the same as the writes.
 *
 * On a migrated scratch database, in check mode warn and on, through the
 * login's MCP surface (prepareCallerTools, an OAuth connection), whose
 * writes run on the write role.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/tree-custom-order.db.test.ts
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

type Mode = 'warn' | 'on';
/** wr: a user of W, which has Write on the folder; rd: a Moderator of R,
 *  Write off; out: a Moderator of O, granted nothing. */
type Who = 'owner' | 'wr' | 'rd' | 'out';
type Outcome = { ok: boolean; text: string };
type Reply = { isError?: boolean; content?: { text?: string }[] };
type Grant = { ws: string; home?: true; write?: true };

describe.skipIf(!DB_URL)('the tree custom order', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let ls: typeof import('@mantle/mcp-core');
  let tree: typeof import('@mantle/content/tree');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let dir = '';
  const tag = `tco${randomUUID().slice(0, 6)}`;
  const L: Record<Who, string> = {
    owner: randomUUID(),
    wr: randomUUID(),
    rd: randomUUID(),
    out: randomUUID(),
  };
  const ws = { admin: '', H: '', W: '', R: '', O: '' };
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  const owner = L.owner;
  const n = () => randomUUID().slice(0, 8);

  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:tco', fn) as Promise<T>;

  /** A builtin as the owner with no scope: the fixture's makes. */
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
        if (g.home) {
          await tx`update item_grants set is_home = false
                    where node_id = ${id} and is_home and workspace_id <> ${g.ws}`;
        }
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${id}, ${g.ws}, ${g.home === true}, ${g.write === true})
                 on conflict (node_id, workspace_id)
                 do update set is_home = excluded.is_home, write = excluded.write,
                               via_folder_id = null, excluded = false`;
      }
      await tx`delete from item_grants where node_id = ${id}
                 and not (workspace_id = any(${grants.map((x) => x.ws)}::uuid[]))`;
    });
  };
  /** Home H, W with Write, R with Write off. */
  const shared = (): Grant[] => [{ ws: ws.H, home: true }, { ws: ws.W, write: true }, { ws: ws.R }];

  /** Set an item's last-changed time as the system (an actor, for check mode on). */
  const stampAgo = (id: string, minutes: number) =>
    raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`update nodes set updated_at = now() - make_interval(mins => ${minutes})
                where id = ${id}`;
    });

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

  const place = (who: Who, itemId: string, after: string | null) =>
    viaMcp(who, 'tree_item_place', { kind: 'notes', item_id: itemId, after });

  const setMode = async (mode: Mode) => {
    await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
    await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
    process.env.MANTLE_ACTOR_CHECK = mode;
    actorMode.noteBoxActorCheckMode(mode);
  };

  /** Every rank and change time of the owner's nodes: a refused place
   *  changes none. */
  const ranksState = async () =>
    (
      await raw<{ s: string }[]>`
        select coalesce(string_agg(id::text || ' ' || coalesce(data->>'tree_rank', '-') || ' '
                                   || updated_at::text, E'\n' order by id), '') as s
          from nodes where owner_id = ${owner}`
    )[0]!.s;

  const notesFolder = async (name: string, parent?: string) =>
    idIn(
      await sysTool('tree_folder_create', {
        kind: 'notes',
        name,
        ...(parent ? { parent_id: parent } : {}),
      }),
    );
  const note = async (title: string) =>
    idIn(await sysTool('note_create', { title: `${tag} ${title}`, content: 'x' }));
  const noteIn = async (folder: string, title: string) => {
    const id = await note(title);
    await sysTool('tree_item_move', {
      kind: 'notes',
      item_ids: [id],
      folder_id: folder,
      confirm: true,
    });
    return id;
  };

  /** The folder's items in the order the tree lists them under `custom`. */
  const listed = async (folderId: string | null) => {
    const page = await sys(() =>
      tree.loadTreeFolder(owner, 'notes', { folderId, sort: 'custom', limit: 100 }),
    );
    return { ordered: page!.ordered, ids: page!.items.map((i) => i.id), page: page! };
  };

  /** A refusal: nothing changes; a caller that does not read the item gets
   *  a random uuid's answer, byte for byte (the id aside). */
  const refused = async (call: (id: string) => Promise<Outcome>, id: string, reads: boolean) => {
    const before = await ranksState();
    const o = await call(id);
    expect(o.ok, o.text).toBe(false);
    expect(o.text, 'no database error').not.toMatch(/could not run this request|THROWN/);
    expect(await ranksState(), 'a refused place changed a row').toBe(before);
    if (!reads) {
      const rnd = randomUUID();
      const r = await call(rnd);
      expect(o.text.replaceAll(id, '<id>')).toBe(r.text.replaceAll(rnd, '<id>'));
    }
    return o;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'tree-custom-order-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'tree-custom-order-test-secret-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the custom order test', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    ls = await import('@mantle/mcp-core');
    tree = await import('@mantle/content/tree');
    actorMode = await import('../../../packages/db/src/actor');
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-owner@example.invalid`}, 'x', true, 'admin', 'Owner'),
             (${L.wr}, ${`${tag}-wr@example.invalid`}, 'x', false, 'member', 'Writer'),
             (${L.rd}, ${`${tag}-rd@example.invalid`}, 'x', false, 'member', 'Reader'),
             (${L.out}, ${`${tag}-out@example.invalid`}, 'x', false, 'member', 'Outsider')`;
    await raw`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    ws.admin = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
                                  where owner_id = ${owner} and is_admin`
    )[0]!.id;
    for (const key of ['H', 'W', 'R', 'O'] as const) {
      ws[key] = (
        await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
          values (${owner}, ${`${tag} ${key}`}) returning id::text as id`
      )[0]!.id;
    }
    const members = [L.wr, L.rd, L.out];
    await raw`delete from workspace_users where workspace_id = ${ws.admin}
               and login_id in ${raw(members)}`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.W}, ${L.wr}, false), (${ws.R}, ${L.rd}, true), (${ws.O}, ${L.out}, true)`;
    await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
    await sys(() => tree.ensureKindRoot(owner, 'notes'));
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('an unordered folder lists in the kind’s other sort, and says it is not ordered', async () => {
    const f = await notesFolder(`${tag} plain ${n()}`);
    const a = await noteIn(f, 'b plain');
    const b = await noteIn(f, 'a plain');
    // Notes list by last updated (their first sort): b was filed last.
    await stampAgo(b, -1);
    const l = await listed(f);
    expect(l.ordered).toBe(false);
    expect(l.page.sort).toBe('custom');
    expect(l.ids).toEqual([b, a]);
    expect(tree.treeFallbackSort('notes')).toBe('updated');
  });

  it('a task’s board order is not a custom order: its folder lists by due date', async () => {
    await sys(() => tree.ensureKindRoot(owner, 'tasks'));
    const f = idIn(
      await sysTool('tree_folder_create', { kind: 'tasks', name: `${tag} board ${n()}` }),
    );
    const t1 = idIn(await sysTool('task_create', { title: `${tag} t1` }));
    await sysTool('tree_item_move', { kind: 'tasks', item_ids: [t1], folder_id: f, confirm: true });
    // A board drag writes `rank`, never `tree_rank`.
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`update nodes set data = data || '{"rank": "i"}'::jsonb where id = ${t1}`;
    });
    const page = await sys(() =>
      tree.loadTreeFolder(owner, 'tasks', { folderId: f, sort: 'custom' }),
    );
    expect(page!.ordered).toBe(false);
    expect(page!.items.map((i) => i.id)).toEqual([t1]);
  });

  for (const mode of ['warn', 'on'] as const) {
    describe(`check mode ${mode}`, () => {
      it("a Write grant's member orders a folder's items, one order for everyone", async () => {
        await setMode(mode);
        const f = await notesFolder(`${tag} stages ${n()}`);
        await grantsOn(f, shared());
        const s1 = await noteIn(f, 'stage c');
        const s2 = await noteIn(f, 'stage a');
        const s3 = await noteIn(f, 'stage b');
        // Notes list newest first until ordered: s3, s2, s1.
        await stampAgo(s1, 3);
        await stampAgo(s2, 2);
        await stampAgo(s3, 1);
        expect((await listed(f)).ids).toEqual([s3, s2, s1]);
        const stamps = async () =>
          (
            await raw<{ s: string }[]>`
              select string_agg(updated_at::text, ',' order by id) as s from nodes
               where id in (${s1}, ${s2}, ${s3})`
          )[0]!.s;
        const before = await stamps();

        // The first place ranks the folder whole, in the order it showed:
        // only the moved item changes place.
        const first = await place('wr', s1, null);
        expect(first.ok, first.text).toBe(true);
        let l = await listed(f);
        expect(l.ordered).toBe(true);
        expect(l.ids).toEqual([s1, s3, s2]);
        const ranks = await raw<{ rank: string | null; board: boolean }[]>`
          select data->>'tree_rank' as rank, data ? 'rank' as board
            from nodes where id in (${s1}, ${s2}, ${s3})`;
        expect(ranks.every((r) => r.rank !== null)).toBe(true);
        // Its own key: a task's board order (`rank`) is never touched.
        expect(ranks.some((r) => r.board)).toBe(false);

        // A later place writes the moved item only.
        const rankOf = async (id: string) =>
          (
            await raw<{ r: string }[]>`select data->>'tree_rank' as r from nodes where id = ${id}`
          )[0]!.r;
        const [r1, r3] = [await rankOf(s1), await rankOf(s3)];
        const second = await place('wr', s2, s1);
        expect(second.ok, second.text).toBe(true);
        expect([await rankOf(s1), await rankOf(s3)]).toEqual([r1, r3]);
        l = await listed(f);
        expect(l.ids).toEqual([s1, s2, s3]);

        // Another writer's place shows to everyone: one order.
        await sysTool('tree_item_place', { kind: 'notes', item_id: s3, after: null });
        expect((await listed(f)).ids).toEqual([s3, s1, s2]);

        // An order is no edit of the item: its last-changed time stays.
        expect(await stamps()).toBe(before);
      });

      it('the read grant’s member and the outsider are refused, nothing changes', async () => {
        await setMode(mode);
        const f = await notesFolder(`${tag} locked ${n()}`);
        await grantsOn(f, shared());
        const a = await noteIn(f, 'one');
        await noteIn(f, 'two');
        const rd = await refused((id) => place('rd', id, null), a, true);
        expect(rd.text).toMatch(/cannot change|Write|Moderator|not allowed/i);
        await refused((id) => place('out', id, null), a, false);
      });

      it('the top level is ordered by an Admin only', async () => {
        await setMode(mode);
        const top = await note(`top ${n()}`);
        const [row] = await raw<
          { p: string }[]
        >`select path::text as p from nodes where id = ${top}`;
        expect(row!.p).toBe('notes');
        await grantsOn(top, shared());
        const wr = await refused((id) => place('wr', id, null), top, true);
        expect(wr.text).toMatch(/Only an Admin orders the top level/);
        // The owner's Admin scope reads what the Admin workspace holds.
        const own = await note(`top admin ${n()}`);
        const owner = await viaMcp('owner', 'tree_item_place', {
          kind: 'notes',
          item_id: own,
          after: null,
        });
        expect(owner.ok, owner.text).toBe(true);
      });

      it("a Write grant's member orders the subfolders of the folder", async () => {
        await setMode(mode);
        const f = await notesFolder(`${tag} parent ${n()}`);
        await grantsOn(f, shared());
        const a = await notesFolder('a stage', f);
        const b = await notesFolder('b stage', f);
        const order = async () =>
          (await listed(f)).page.folders.map((x) => x.id).filter((id) => id === a || id === b);
        expect(await order()).toEqual([a, b]);
        const moved = await viaMcp('wr', 'tree_folder_update', {
          kind: 'notes',
          folder_id: b,
          after: null,
        });
        expect(moved.ok, moved.text).toBe(true);
        expect(await order()).toEqual([b, a]);
        await refused(
          (id) => viaMcp('rd', 'tree_folder_update', { kind: 'notes', folder_id: id, after: null }),
          a,
          true,
        );
      });

      it('mayOrderFolder answers as the writes do', async () => {
        await setMode(mode);
        const f = await notesFolder(`${tag} may ${n()}`);
        await grantsOn(f, shared());
        const [row] = await raw<{ p: string }[]>`select path::text as p from nodes where id = ${f}`;
        const may = (who: Who, p: string) =>
          m.withViewer({ login: L[who] }, () => tree.mayOrderFolder(owner, 'notes', p));
        expect(await may('wr', row!.p)).toBe(true);
        expect(await may('rd', row!.p)).toBe(false);
        expect(await may('out', row!.p)).toBe(false);
        expect(await may('wr', 'notes')).toBe(false);
        expect(await may('owner', 'notes')).toBe(true);
      });
    });
  }
});
