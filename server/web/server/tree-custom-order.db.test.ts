/**
 * The tree's custom order (docs/folder-tree.md, "Custom order"): one order
 * for everyone, set by whoever may edit the folder (owner decision
 * 2026-10-26). An item's place is its `data.tree_rank`, a presentation key
 * (0281, 0335): the database lets edit of the item or of its folder change
 * it, and placeTreeItem asks Write on the folder (an Admin scope at the top
 * level).
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
  let runRoute: typeof import('./run-route').runRoute;
  let itemArgs: typeof import('../../../packages/tools/src/item-args');
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

  /** Merge `patch` into an item's data as the system (a copy's mark, a
   *  rank set by hand). */
  const setData = (id: string, patch: Record<string, unknown>) =>
    raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`update nodes set data = coalesce(data, '{}'::jsonb) || ${JSON.stringify(patch)}::text::jsonb
                where id = ${id}`;
    });
  const rankOf = async (id: string) =>
    (
      await raw<{ r: string | null }[]>`select data->>'tree_rank' as r from nodes where id = ${id}`
    )[0]!.r;

  /** Hide an item from W (and R): its folder's grants "Removed here", its
   *  home O (a3a-folders.db.test.ts hide). */
  const hide = (id: string) =>
    raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`update item_grants set excluded = true, is_home = false, write = false
                where node_id = ${id}`;
      await tx`insert into item_grants (node_id, workspace_id, is_home) values (${id}, ${ws.O}, true)
                on conflict (node_id, workspace_id)
                do update set is_home = true, excluded = false, via_folder_id = null`;
    });

  /**
   * Run `fn` and answer each UPDATE statement on nodes that changed a rank
   * (`tree_rank` or `rank`), by how many rows it changed: a statement
   * trigger with transition tables, installed for the call only.
   */
  const rankStatements = async (fn: () => Promise<unknown>): Promise<number[]> => {
    await raw.unsafe(`
      create table if not exists tco_rank_statements (n int, at timestamptz default clock_timestamp());
      create or replace function tco_rank_statements_trg() returns trigger
        language plpgsql security definer set search_path = public as $f$
      begin
        insert into tco_rank_statements (n)
          select count(*) from nt join ot on ot.id = nt.id
           where nt.data->>'tree_rank' is distinct from ot.data->>'tree_rank'
              or nt.data->>'rank' is distinct from ot.data->>'rank'
          having count(*) > 0;
        return null;
      end $f$;
      drop trigger if exists tco_rank_statements on nodes;
      create trigger tco_rank_statements after update on nodes
        referencing old table as ot new table as nt
        for each statement execute function tco_rank_statements_trg();
      truncate tco_rank_statements;`);
    try {
      await fn();
      return (await raw<{ n: number }[]>`select n from tco_rank_statements order by at`).map((r) =>
        Number(r.n),
      );
    } finally {
      await raw.unsafe('drop trigger if exists tco_rank_statements on nodes');
    }
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
    runRoute = (await import('./run-route')).runRoute;
    itemArgs = await import('../../../packages/tools/src/item-args');
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

  it('a whole ranking is one statement, and a later place one row', async () => {
    await setMode('on');
    const f = await notesFolder(`${tag} batch ${n()}`);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await noteIn(f, `batch ${i}`));
    // Unordered: the first place ranks the six whole, in one UPDATE.
    expect(
      await rankStatements(() =>
        sysTool('tree_item_place', { kind: 'notes', item_id: ids[0], after: null }),
      ),
    ).toEqual([6]);
    // Ordered, room between: one statement, one row.
    expect(
      await rankStatements(() =>
        sysTool('tree_item_place', { kind: 'notes', item_id: ids[1], after: ids[0] }),
      ),
    ).toEqual([1]);
  });

  it('a read-only copy is no neighbour: its inherited rank never forces a ranking', async () => {
    await setMode('on');
    const f = await notesFolder(`${tag} copy ${n()}`);
    const a = await noteIn(f, 'a copy test');
    const b = await noteIn(f, 'b copy test');
    const c = await noteIn(f, 'c copy test');
    const x = await noteIn(f, 'x copy test');
    await sysTool('tree_item_place', { kind: 'notes', item_id: a, after: null });
    await sysTool('tree_item_place', { kind: 'notes', item_id: b, after: a });
    await sysTool('tree_item_place', { kind: 'notes', item_id: x, after: b });
    // c becomes a snapshot copy of a, carrying a's rank: it lists beside a.
    const ra = await rankOf(a);
    await setData(c, { snapshot_of: a, tree_rank: ra });
    const [rb, rc] = [await rankOf(b), await rankOf(c)];
    expect((await listed(f)).ids).toEqual([a, c, b, x]);
    // x after a goes between a and b (c skipped): x alone is written, and
    // the copy's tie with a forces nothing.
    expect(
      await rankStatements(() =>
        sysTool('tree_item_place', { kind: 'notes', item_id: x, after: a }),
      ),
    ).toEqual([1]);
    expect([await rankOf(a), await rankOf(b), await rankOf(c)]).toEqual([ra, rb, rc]);
    const rx = (await rankOf(x))!;
    expect(rx > ra! && rx < rb!).toBe(true);
    // The copy itself is never placed, and an order made only of a copy's
    // inherited rank is no order.
    const copyPlace = await viaMcp('owner', 'tree_item_place', {
      kind: 'notes',
      item_id: c,
      after: null,
    });
    expect(copyPlace.ok).toBe(false);
    const g = await notesFolder(`${tag} copy only ${n()}`);
    const lone = await noteIn(g, 'lone copy');
    await noteIn(g, 'plain');
    await setData(lone, { snapshot_of: a, tree_rank: ra });
    expect((await listed(g)).ordered).toBe(false);
  });

  it('two real items that tie are ranked again, in the order shown', async () => {
    await setMode('on');
    const f = await notesFolder(`${tag} tie ${n()}`);
    const p = await noteIn(f, 'p tie');
    const q = await noteIn(f, 'q tie');
    const y = await noteIn(f, 'y tie');
    await sysTool('tree_item_place', { kind: 'notes', item_id: p, after: null });
    await sysTool('tree_item_place', { kind: 'notes', item_id: q, after: p });
    await sysTool('tree_item_place', { kind: 'notes', item_id: y, after: q });
    await setData(q, { tree_rank: await rankOf(p) });
    expect((await listed(f)).ids).toEqual([p, q, y]);
    const placed = await viaMcp('owner', 'tree_item_place', {
      kind: 'notes',
      item_id: y,
      after: p,
    });
    expect(placed.ok, placed.text).toBe(true);
    expect((await listed(f)).ids).toEqual([p, y, q]);
    const ranks = [await rankOf(p), await rankOf(y), await rankOf(q)];
    expect(new Set(ranks).size).toBe(3);
  });

  it('places in one folder run one at a time: concurrent folder places never tie', async () => {
    await setMode('on');
    const p = await notesFolder(`${tag} conc ${n()}`);
    const x = await notesFolder('x', p);
    const y = await notesFolder('y', p);
    await sys(() => tree.updateTreeFolder(owner, 'notes', y, { after: x }));
    for (let round = 0; round < 4; round++) {
      const c1 = await notesFolder(`c1 ${round}`, p);
      const c2 = await notesFolder(`c2 ${round}`, p);
      await Promise.all([
        sys(() => tree.updateTreeFolder(owner, 'notes', c1, { after: x })),
        sys(() => tree.updateTreeFolder(owner, 'notes', c2, { after: x })),
      ]);
      const [row] = await raw<{ total: number; distinct: number; unranked: number }[]>`
        select count(*)::int as total, count(distinct data->>'rank')::int as distinct,
               count(*) filter (where data->>'rank' is null)::int as unranked
          from nodes where owner_id = ${owner} and type = 'branch'
           and path ~ ${`${(await raw<{ p: string }[]>`select path::text as p from nodes where id = ${p}`)[0]!.p}.*{1}`}::lquery`;
      expect(row!.unranked).toBe(0);
      expect(row!.distinct).toBe(row!.total);
      const order = (await listed(p)).page.folders.map((f) => f.id);
      expect(order[0]).toBe(x);
      expect(order.at(-1)).toBe(y);
      expect(order.slice(1, 3).sort()).toEqual([c1, c2].sort());
    }
  });

  it('a place among ranked neighbours reads them alone: one row, an unranked newcomer aside', async () => {
    await setMode('on');
    const f = await notesFolder(`${tag} near ${n()}`);
    const a = await noteIn(f, 'a near');
    const b = await noteIn(f, 'b near');
    const c = await noteIn(f, 'c near');
    await sysTool('tree_item_place', { kind: 'notes', item_id: a, after: null });
    await sysTool('tree_item_place', { kind: 'notes', item_id: b, after: a });
    await sysTool('tree_item_place', { kind: 'notes', item_id: c, after: b });
    // A newcomer has no rank: it lists last, and a place between two ranked
    // neighbours still writes the moved one only.
    const fresh = await noteIn(f, 'fresh near');
    expect(
      await rankStatements(() =>
        sysTool('tree_item_place', { kind: 'notes', item_id: c, after: a }),
      ),
    ).toEqual([1]);
    expect((await listed(f)).ids).toEqual([a, c, b, fresh]);
    // Placing after the newcomer needs a rank for it: the ranking appends.
    const placed = await viaMcp('owner', 'tree_item_place', {
      kind: 'notes',
      item_id: a,
      after: fresh,
    });
    expect(placed.ok, placed.text).toBe(true);
    expect((await listed(f)).ids).toEqual([c, b, fresh, a]);
    // An `after` from another folder is refused, nothing written.
    const other = await noteIn(await notesFolder(`${tag} near other ${n()}`), 'elsewhere');
    const before = await ranksState();
    const stray = await viaMcp('owner', 'tree_item_place', {
      kind: 'notes',
      item_id: b,
      after: other,
    });
    expect(stray.ok).toBe(false);
    expect(stray.text).toMatch(/not in this folder/);
    expect(await ranksState()).toBe(before);
  });

  it('a move to another folder drops the place: the item lands unranked, never ordering it', async () => {
    await setMode('on');
    const from = await notesFolder(`${tag} from ${n()}`);
    const to = await notesFolder(`${tag} to ${n()}`);
    const a = await noteIn(from, 'a from');
    const b = await noteIn(from, 'b from');
    await sysTool('tree_item_place', { kind: 'notes', item_id: b, after: null });
    expect(await rankOf(a)).not.toBeNull();
    await noteIn(to, 'x to');
    await noteIn(to, 'y to');
    expect((await listed(to)).ordered).toBe(false);
    await sysTool('tree_item_move', { kind: 'notes', item_ids: [a], folder_id: to, confirm: true });
    expect(await rankOf(a)).toBeNull();
    expect((await listed(to)).ordered).toBe(false);
    // A move into the folder it is in keeps it.
    const rb = await rankOf(b);
    await sysTool('tree_item_move', {
      kind: 'notes',
      item_ids: [b],
      folder_id: from,
      confirm: true,
    });
    expect(await rankOf(b)).toBe(rb);

    // A folder moved under another parent drops its place among the
    // folders it left (`rank`); the order inside it stays.
    const p1 = await notesFolder(`${tag} p1 ${n()}`);
    const p2 = await notesFolder(`${tag} p2 ${n()}`);
    const k = await notesFolder('k', p1);
    await notesFolder('l', p1);
    const inK = await noteIn(k, 'in k');
    await noteIn(k, 'in k 2');
    await sysTool('tree_item_place', { kind: 'notes', item_id: inK, after: null });
    await sys(() => tree.updateTreeFolder(owner, 'notes', k, { after: null }));
    const folderRank = async (id: string) =>
      (await raw<{ r: string | null }[]>`select data->>'rank' as r from nodes where id = ${id}`)[0]!
        .r;
    expect(await folderRank(k)).not.toBeNull();
    const rk = await rankOf(inK);
    await sys(() => tree.updateTreeFolder(owner, 'notes', k, { parentId: p2 }, { confirm: true }));
    expect(await folderRank(k)).toBeNull();
    expect(await rankOf(inK)).toBe(rk);
  });

  it('the lift of a deleted folder drops the places of what lands in another folder', async () => {
    await setMode('on');
    const parent = await notesFolder(`${tag} lift ${n()}`);
    const gone = await notesFolder('gone', parent);
    const keep = await notesFolder('keep', gone);
    await notesFolder('keep 2', gone);
    const direct = await noteIn(gone, 'direct');
    await noteIn(gone, 'direct 2');
    const deep = await noteIn(keep, 'deep');
    await noteIn(keep, 'deep 2');
    await sysTool('tree_item_place', { kind: 'notes', item_id: direct, after: null });
    await sysTool('tree_item_place', { kind: 'notes', item_id: deep, after: null });
    await sys(() => tree.updateTreeFolder(owner, 'notes', keep, { after: null }));
    const rDeep = await rankOf(deep);
    await sys(() => tree.deleteTreeFolder(owner, 'notes', gone, { confirm: true }));
    // Lands in the parent: no place there.
    expect(await rankOf(direct)).toBeNull();
    const [k] = await raw<
      { r: string | null }[]
    >`select data->>'rank' as r from nodes where id = ${keep}`;
    expect(k!.r).toBeNull();
    // A subfolder that moves up whole keeps the order inside it.
    expect(await rankOf(deep)).toBe(rDeep);
  });

  it('a copy carries no place (Files), and a Files move drops it', async () => {
    await setMode('on');
    const filesFolder = async (slug: string) =>
      ((await sysTool('folder_create', { parent_path: 'files', slug })) as { path: string }).path;
    const destPath = await filesFolder(`${tag}-fdest-${n()}`);
    const made = (await sysTool('file_create', {
      parent_path: 'files',
      filename: `${tag}-${n()}.md`,
      content: 'x',
    })) as { id: string };
    await setData(made.id, { tree_rank: 'i' });
    const copy = (await sysTool('file_copy', {
      file_id: made.id,
      dest_path: destPath,
      confirm: true,
    })) as { id: string };
    expect(await rankOf(copy.id)).toBeNull();
    expect(await rankOf(made.id)).toBe('i');
    // The copy took the name there: the move goes to a folder of its own.
    const movePath = await filesFolder(`${tag}-fmove-${n()}`);
    await sysTool('file_move', { file_id: made.id, dest_path: movePath, confirm: true });
    expect(await rankOf(made.id)).toBeNull();
  });

  it('a look change writes its own keys only: the place stays', async () => {
    await setMode('on');
    const p = await notesFolder(`${tag} look ${n()}`);
    const x = await notesFolder('x look', p);
    await notesFolder('y look', p);
    await sys(() => tree.updateTreeFolder(owner, 'notes', x, { after: null }));
    await setData(x, { icon: 'old', keepme: 1 });
    const data = async () =>
      (await raw<{ d: Record<string, unknown> }[]>`select data as d from nodes where id = ${x}`)[0]!
        .d;
    const rank = (await data()).rank;
    expect(rank).toBeTruthy();
    await sys(() => tree.updateTreeFolder(owner, 'notes', x, { color: 'blue' as never }));
    let d = await data();
    expect(d).toMatchObject({ rank, icon: 'old', color: 'blue', keepme: 1 });
    await sys(() => tree.updateTreeFolder(owner, 'notes', x, { icon: null }));
    d = await data();
    expect(d.icon).toBeUndefined();
    expect(d).toMatchObject({ rank, color: 'blue', keepme: 1 });
  });

  it('a move with an `after` that is not in the destination is refused before it moves', async () => {
    await setMode('on');
    const p1 = await notesFolder(`${tag} m1 ${n()}`);
    const p2 = await notesFolder(`${tag} m2 ${n()}`);
    const mover = await notesFolder('mover', p1);
    const stale = await notesFolder('stale', p1);
    await notesFolder('there', p2);
    const pathOf = async (id: string) =>
      (await raw<{ p: string }[]>`select path::text as p from nodes where id = ${id}`)[0]!.p;
    const before = await pathOf(mover);
    const state = await ranksState();
    const err = await sys(() =>
      tree.updateTreeFolder(
        owner,
        'notes',
        mover,
        { parentId: p2, after: stale },
        { confirm: true },
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(tree.TreeError);
    expect((err as InstanceType<typeof tree.TreeError>).code).toBe('invalid');
    expect(await pathOf(mover)).toBe(before);
    expect(await ranksState()).toBe(state);
    // Over HTTP: the 400, nothing moved.
    const res = await runRoute(owner, 'PATCH', `/api/tree/notes/folders/${mover}`, {
      parentId: p2,
      after: stale,
      confirm: true,
    });
    expect(res.status, await res.clone().text()).toBe(400);
    expect(await pathOf(mover)).toBe(before);
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

      it('at the top level, an item the Admin may not edit is refused first', async () => {
        await setMode(mode);
        const top = await note(`top locked ${n()}`);
        // Homed in H, read by the Admin workspace with Write off.
        await grantsOn(top, [{ ws: ws.H, home: true }, { ws: ws.admin }]);
        const o = await refused(
          (id) => viaMcp('owner', 'tree_item_place', { kind: 'notes', item_id: id, after: null }),
          top,
          true,
        );
        expect(o.text).not.toMatch(/Only an Admin orders the top level/);
      });

      it("a member's place in an ordered folder leaves what it does not see where it was", async () => {
        await setMode(mode);
        const f = await notesFolder(`${tag} hidden ${n()}`);
        await grantsOn(f, shared());
        const s1 = await noteIn(f, 'h s1');
        const h1 = await noteIn(f, 'h h1');
        const s2 = await noteIn(f, 'h s2');
        const s3 = await noteIn(f, 'h s3');
        // The owner orders the four: s1, h1, s2, s3.
        await sysTool('tree_item_place', { kind: 'notes', item_id: s1, after: null });
        await sysTool('tree_item_place', { kind: 'notes', item_id: h1, after: s1 });
        await sysTool('tree_item_place', { kind: 'notes', item_id: s2, after: h1 });
        await sysTool('tree_item_place', { kind: 'notes', item_id: s3, after: s2 });
        await hide(h1);
        const seen = await m.withViewer({ login: L.wr }, () =>
          tree.loadTreeFolder(owner, 'notes', { folderId: f, sort: 'custom', limit: 100 }),
        );
        expect(seen!.items.map((i) => i.id)).not.toContain(h1);
        // A new item has no rank: it lists last. Placing s2 after it needs
        // a rank for it, which comes after the last; nothing else moves.
        const s4 = await noteIn(f, 'h s4');
        const before = [await rankOf(s1), await rankOf(h1), await rankOf(s3)];
        const placed = await place('wr', s2, s4);
        expect(placed.ok, placed.text).toBe(true);
        expect([await rankOf(s1), await rankOf(h1), await rankOf(s3)]).toEqual(before);
        expect((await listed(f)).ids).toEqual([s1, h1, s3, s4, s2]);
      });

      it("an `after` alone asks the parent's order right, not the folder's edit (HTTP)", async () => {
        await setMode(mode);
        const f = await notesFolder(`${tag} http ${n()}`);
        await grantsOn(f, shared());
        const a = await notesFolder('a http', f);
        const b = await notesFolder('b http', f);
        // b is read by W, not written: its own grants, Write off.
        await grantsOn(b, [{ ws: ws.H, home: true }, { ws: ws.W }, { ws: ws.R }]);
        const patch = (who: Who, body: Record<string, unknown>) =>
          runRoute(L[who], 'PATCH', `/api/tree/notes/folders/${b}`, body);
        const order = async () =>
          (await listed(f)).page.folders.map((x) => x.id).filter((id) => id === a || id === b);
        expect(await order()).toEqual([a, b]);
        const placed = await patch('wr', { after: null });
        expect(placed.status, await placed.clone().text()).toBe(200);
        expect(await order()).toEqual([b, a]);
        // A rename still asks edit of the folder itself.
        const renamed = await patch('wr', { name: `${tag} renamed` });
        expect(renamed.status, await renamed.clone().text()).toBe(403);
        // The approval queue asks no more than the run: an `after` alone
        // passes it with the folder's read, and the run refuses a rename.
        const queued = (input: Record<string, unknown>) =>
          m.withViewer({ login: L.wr }, () =>
            itemArgs.queueItemRefusal(
              itemArgs.itemArgsOf('tree_folder_update'),
              { kind: 'notes', folder_id: b, ...input },
              owner,
            ),
          );
        expect(await queued({ after: a })).toBeNull();
        const viaTool = await viaMcp('wr', 'tree_folder_update', {
          kind: 'notes',
          folder_id: b,
          name: `${tag} renamed by tool`,
        });
        expect(viaTool.ok, viaTool.text).toBe(false);
        expect(await order()).toEqual([b, a]);
        // R has no Write on the parent: its member may not order it.
        const rd = await patch('rd', { after: a });
        expect(rd.status, await rd.clone().text()).toBe(403);
        expect(await order()).toEqual([b, a]);
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
