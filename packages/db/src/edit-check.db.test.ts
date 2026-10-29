/**
 * The edit check (workspaces arch A3a, docs/edit-check.md; migrations 0280
 * and 0281), on a real login of the write role:
 *
 *  - the switch: mantle_set_edit_check flips every edit check trigger with
 *    the box setting; a session can only raise the mode;
 *  - off is today's behaviour (a write A3a refuses in on runs, and nothing
 *    is reported), warn runs it and reports it, on refuses it with the
 *    detail the mapper reads;
 *  - the read-only refusal, also on the system pool, and never for a heads
 *    lock;
 *  - the heads locks filtered by the scope;
 *  - the derived keys and the brain's columns of nodes; an app's switches
 *    (D5) and a new app's code (D4); a contact share (an Admin user);
 *  - the two definers of 0281 (a renamed Recall map, a secret);
 *  - migrate's sync of the matrix-made triggers (no change takes no lock,
 *    a new trigger follows the box mode) and the coverage.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/edit-check.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ITEM_KINDS } from '@mantle/client-types/kinds';
import { ACCESS_MATRIX, editCheckTriggers, syncWriteRoleRules } from './access-matrix';
import { EDIT_CHECK_DRIFT_SQL } from './gateway/check-mode';
import { NODE_DERIVED_KEYS } from './edit-check';
import { createMigratedScratchDatabase } from './test-support';
import { viewerDatabaseUrl, viewerRolePassword } from './viewer';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

class Rollback extends Error {}

type Who = { ws: string[]; mod: string[]; login: string; actor: string; mode?: 'rw' | 'ro' };
type Result =
  | { rows: number; notices: string[] }
  | { code: string; detail: string; message: string; notices: string[] };

const VECTOR = `[${Array.from({ length: 768 }, () => '0.01').join(',')}]`;

describe.skipIf(!URL)('the edit check (arch A3a)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let w: ReturnType<typeof postgres>;
  const testKey = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
  const tag = `ec${randomUUID().slice(0, 6)}`;
  const L = {
    owner: randomUUID(),
    homeMod: randomUUID(),
    member: randomUUID(),
    adminWriter: randomUUID(),
    outsider: randomUUID(),
  };
  const ws = { admin: '', H: '', W: '', O: '' };
  const n = {
    note: '',
    page: '',
    app: '',
    info: '',
    map: '',
    map2: '',
    other: '',
    secret: '',
    contact: '',
  };
  const who = {} as Record<keyof typeof L, Who>;
  let notices: string[] = [];

  const rootOf = (kind: string): string =>
    (ITEM_KINDS as Record<string, { tree: { root: string } | null }>)[kind]?.tree?.root ??
    `${kind}s`;

  /** An item of `kind` at its kind's root, its grants `grants`. */
  const item = async (
    kind: string,
    grants: [string, boolean, boolean][],
    data: Record<string, unknown> = {},
  ): Promise<string> => {
    const root = rootOf(kind);
    await sql`insert into nodes (owner_id, type, title, path)
              select ${L.owner}, 'branch', ${root}, ${root}::ltree
               where not exists (select 1 from nodes where owner_id = ${L.owner}
                                   and type = 'branch' and path = ${root}::ltree)`;
    const id = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into nodes (id, owner_id, type, title, path, data)
               values (${id}, ${L.owner}, ${kind}, ${`${tag} ${kind}`}, ${root}::ltree, ${sql.json(data as never)})`;
    });
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
      for (const [wsId, home, write] of grants) {
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${id}, ${wsId}, ${home}, ${write})`;
      }
    });
    return id;
  };

  /** Run `fn` as `p` on the write role, roll back; the rows it changed, or
   *  the refusal, and the notices it raised. */
  const attempt = async (
    p: Who,
    fn: (tx: postgres.TransactionSql) => Promise<{ count: number }>,
    heads: string[] = [],
    pool: ReturnType<typeof postgres> = w,
  ): Promise<Result> => {
    notices = [];
    let out: Result | null = null;
    await pool
      .begin(async (tx) => {
        // A login's write carries its scope; system work none.
        if (p.login !== '') {
          await tx`select set_config('mantle.ws', ${`{${p.ws.join(',')}}`}, true),
                          set_config('mantle.mod_ws', ${`{${p.mod.join(',')}}`}, true),
                          set_config('mantle.login_id', ${p.login}, true)`;
        }
        await tx`select set_config('mantle.actor', ${p.actor}, true),
                        set_config('mantle.write_mode', ${p.mode ?? 'rw'}, true),
                        set_config('mantle.actor_check', 'on', true)`;
        if (heads.length > 0) await tx`select mantle_lock_heads(${heads}::uuid[], 'update')`;
        try {
          const r = await fn(tx);
          out = { rows: r.count, notices };
        } catch (err) {
          const e = err as { code?: string; detail?: string; message?: string };
          out = { code: e.code ?? '', detail: e.detail ?? '', message: e.message ?? '', notices };
        }
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
    return out!;
  };
  const HWgrants = (): [string, boolean, boolean][] => [
    [ws.H, true, false],
    [ws.W, false, true],
  ];
  const editMisses = (r: Result) =>
    r.notices.filter((m) => m.startsWith('mantle actor miss: edit: '));
  const setMode = (m: 'off' | 'warn' | 'on') => sql`select mantle_set_edit_check(${m}, 50, 'test')`;

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    // The file starts off, as every box does, before its connections open:
    // a connection keeps the database's setting from when it opened (a test
    // config may have switched the scratch database).
    const first = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await first`select mantle_set_edit_check('off', 50, 'test')`;
    await first.end();
    const onnotice = (x: { message?: string }) => notices.push(String(x.message ?? ''));
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice });
    w = postgres(viewerDatabaseUrl(scratch.url, 'write', viewerRolePassword(testKey, 'write')), {
      max: 1,
      prepare: false,
      onnotice,
    });
    await sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${L.owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${L.adminWriter}, ${`${tag}-a@example.invalid`}, 'x', false, 'admin', 'Admin writer'),
      (${L.homeMod}, ${`${tag}-h@example.invalid`}, 'x', false, 'member', 'Home mod'),
      (${L.member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member'),
      (${L.outsider}, ${`${tag}-x@example.invalid`}, 'x', false, 'member', 'Outsider')`;
    await sql`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
      on conflict (id) do nothing`;
    await sql`select * from mantle_ws_migrate()`;
    ws.admin = (
      await sql<{ id: string }[]>`select id::text as id from workspaces
        where owner_id = ${L.owner} and is_admin`
    )[0]!.id;
    for (const [key, seats] of [
      ['H', [[L.homeMod, true]]],
      [
        'W',
        [
          [L.member, false],
          [L.adminWriter, false],
        ],
      ],
      ['O', [[L.outsider, true]]],
    ] as const) {
      const [row] = await sql<{ id: string }[]>`
        insert into workspaces (owner_id, name) values (${L.owner}, ${`${tag} ${key}`})
        returning id::text as id`;
      ws[key] = row!.id;
      for (const [x, mod] of seats) {
        await sql`insert into workspace_users (workspace_id, login_id, moderator)
                  values (${row!.id}, ${x}, ${mod})`;
      }
    }
    await sql`delete from workspace_users u using workspaces w
               where w.id = u.workspace_id and w.name = 'Team' and not w.is_admin
                 and u.login_id in (${L.homeMod}, ${L.member}, ${L.outsider})`;
    for (const k of Object.keys(L) as (keyof typeof L)[]) {
      const [s] = await sql<{ ws: string[]; mod: string[] }[]>`
        select coalesce(array_agg(u.workspace_id::text), '{}') as ws,
               coalesce(array_agg(u.workspace_id::text) filter (where u.moderator), '{}') as mod
          from workspace_users u join workspaces w on w.id = u.workspace_id and w.archived_at is null
         where u.login_id = ${L[k]}`;
      who[k] = {
        ws: s!.ws,
        mod: s!.mod,
        login: L[k],
        actor: `login:${k === 'owner' ? 'owner' : 'rw'}:${L[k]}`,
      };
    }
    const HW = HWgrants();
    n.note = await item('note', HW, { summary: 'the brain’s', rank: 'a0' });
    n.page = await item('page', HW);
    n.app = await item('app', HW);
    n.info = await item('app', HW);
    n.map = await item('recall', HW);
    n.map2 = await item('recall', [[ws.O, true, false]]);
    n.other = await item('note', [[ws.O, true, false]]);
    n.secret = await item('secret', [[ws.admin, true, false]]);
    n.contact = await item('contact', [[ws.admin, true, false]]);
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into pages (node_id) values (${n.page})`;
      await tx`insert into apps (node_id) values (${n.app})`;
      await tx`insert into apps (node_id, data_read_only) values (${n.info}, true)`;
      for (const a of [n.app, n.info]) {
        await tx`insert into app_databases (owner_id, app_node_id, storage_path)
                 values (${L.owner}, ${a}, ${`/tmp/${a}.db`})`;
      }
      await tx`insert into recall_maps (id, owner_id, slug, title, node_id)
               values (${n.map}, ${L.owner}, ${`${tag}-one`}, 'One', ${n.map}),
                      (${n.map2}, ${L.owner}, ${`${tag}-two`}, 'Two', ${n.map2})`;
      await tx`insert into recall_nodes (owner_id, map_id, slug, kind, title, options)
               values (${L.owner}, ${n.map2}, 'jump', 'card', 'Jump',
                       ${sql.json([{ targetMap: `${tag}-one`, targetSlug: `${tag}-one` }] as never)})`;
    });
  }, 240_000);

  afterAll(async () => {
    await w?.end();
    await sql?.end();
    await scratch?.drop();
  });

  // ── The switch ────────────────────────────────────────────────────────────

  it('the switch flips every edit check trigger with the box setting; a session only raises it', async () => {
    const state = async () => {
      const [r] = await sql<{ total: number; on: number; mode: string; box: string }[]>`
        select count(*)::int as total, count(*) filter (where enabled)::int as on,
               mantle_edit_check_mode() as mode, mantle_check_box_mode('edit_check') as box
          from mantle_edit_check_tables()`;
      return r!;
    };
    const off = await state();
    expect(off).toMatchObject({ on: 0, mode: 'off', box: 'off' });
    expect(off.total).toBeGreaterThan(40);
    await setMode('warn');
    expect(await state()).toMatchObject({ on: off.total, mode: 'warn', box: 'warn' });
    // A call that changes nothing switches nothing (and takes no lock).
    const [again] = await sql<{ n: number }[]>`select mantle_edit_check_triggers(true) as n`;
    expect(again!.n).toBe(0);
    // A session can raise the mode, never lower it.
    const [s] = await sql.begin(async (tx) => {
      await tx`select set_config('mantle.edit_check', 'off', true)`;
      const low = await tx<{ m: string }[]>`select mantle_edit_check_mode() as m`;
      await tx`select set_config('mantle.edit_check', 'on', true)`;
      const high = await tx<{ m: string }[]>`select mantle_edit_check_mode() as m`;
      return [{ low: low[0]!.m, high: high[0]!.m }];
    });
    expect(s).toEqual({ low: 'warn', high: 'on' });
    await expect(sql`select mantle_set_edit_check('maybe')`).rejects.toMatchObject({
      code: '22023',
    });
    // The actor check's switch is the same general switch: it never touches
    // the edit check's triggers.
    await sql`select mantle_actor_check_triggers(false)`;
    expect((await state()).on).toBe(off.total);
    // A bare ALTER DATABASE leaves the triggers apart: the drift row shows
    // it (the integrity row and the boot warning read the same SQL).
    expect(await sql.unsafe(EDIT_CHECK_DRIFT_SQL)).toEqual([]);
    const [db] = await sql<{ d: string }[]>`select current_database() as d`;
    await sql.unsafe(`alter database "${db!.d}" reset mantle.edit_check`);
    expect(await sql.unsafe(EDIT_CHECK_DRIFT_SQL)).toMatchObject([
      { mode: 'off', enabled: off.total, total: off.total },
    ]);
    await setMode('off');
    expect(await state()).toMatchObject({ on: 0, mode: 'off', box: 'off' });
    expect(await sql.unsafe(EDIT_CHECK_DRIFT_SQL)).toEqual([]);
  });

  // ── Off, warn, on ─────────────────────────────────────────────────────────

  /** The writes A3a adds a refusal for, as the Write grant user. */
  const stagedWrites = () => {
    const m = who.member;
    return {
      appCode: () =>
        attempt(m, (tx) => tx`update apps set draft_source = '{}'::jsonb where node_id = ${n.app}`),
      pageDelete: () => attempt(m, (tx) => tx`delete from pages where node_id = ${n.page}`),
      readOnly: () =>
        attempt(
          { ...m, actor: `login:ro:${m.login}`, mode: 'ro' },
          (tx) => tx`update nodes set title = title || '.' where id = ${n.note}`,
        ),
      informational: () =>
        attempt(
          m,
          (tx) =>
            tx`update app_databases set size_bytes = size_bytes + 1 where app_node_id = ${n.info}`,
        ),
      derived: () =>
        attempt(
          m,
          (tx) =>
            tx`update nodes set data = data || '{"summary":"forged"}'::jsonb where id = ${n.note}`,
        ),
    };
  };

  it('off is today’s behaviour: every write A3a refuses in on runs, and nothing is reported', async () => {
    await setMode('off');
    for (const [name, run] of Object.entries(stagedWrites())) {
      const r = await run();
      expect(r, name).toMatchObject({ rows: 1 });
      expect(editMisses(r), name).toEqual([]);
    }
  });

  it('warn runs each and reports it as a miss', async () => {
    await setMode('warn');
    for (const [name, run] of Object.entries(stagedWrites())) {
      const r = await run();
      expect(r, name).toMatchObject({ rows: 1 });
      expect(editMisses(r).length, name).toBeGreaterThan(0);
    }
    await setMode('off');
  });

  it('on refuses each, 42501 with the detail the mapper reads', async () => {
    await setMode('on');
    const w8 = stagedWrites();
    expect(await w8.appCode()).toMatchObject({
      code: '42501',
      detail: 'no_edit',
      message: "not allowed to change this app's code: a Moderator of its workspace does",
    });
    expect(await w8.pageDelete()).toMatchObject({ code: '42501', detail: 'no_edit' });
    expect(await w8.readOnly()).toMatchObject({
      code: '42501',
      detail: 'ro_actor',
      message: 'not allowed to change anything: this caller only reads',
    });
    expect(await w8.informational()).toMatchObject({ code: '42501', detail: 'read_only' });
    expect(await w8.derived()).toMatchObject({ code: '42501', detail: 'no_edit' });
    // The Moderator of the home changes the code; the not-Informational
    // app's data is the Write grant's.
    expect(
      await attempt(
        who.homeMod,
        (tx) => tx`update apps set draft_source = '{}'::jsonb where node_id = ${n.app}`,
      ),
    ).toMatchObject({ rows: 1 });
    expect(
      await attempt(
        who.member,
        (tx) =>
          tx`update app_databases set size_bytes = size_bytes + 1 where app_node_id = ${n.app}`,
      ),
    ).toMatchObject({ rows: 1 });
    await setMode('off');
  });

  // ── The read-only refusal ─────────────────────────────────────────────────

  it('a read-only actor writes nothing on the system pool either; a heads lock is no write', async () => {
    await setMode('on');
    const sys = (actor: string, mode: 'rw' | 'ro'): Who => ({
      ws: [],
      mod: [],
      login: '',
      actor,
      mode,
    });
    for (const actor of ['link', 'contact:ro', 'assistant:none', 'peer:none', 'system:http:x']) {
      const r = await attempt(
        sys(actor, 'ro'),
        (tx) => tx`update nodes set title = title where id = ${n.note}`,
        [n.note],
        sql,
      );
      expect(r, actor).toMatchObject({ code: '42501', detail: 'ro_actor' });
    }
    // The same system work in rw writes (a named repair, the brain's own).
    expect(
      await attempt(
        sys('system:repair:x', 'rw'),
        (tx) => tx`update nodes set title = title where id = ${n.note}`,
        [n.note],
        sql,
      ),
    ).toMatchObject({ rows: 1 });
    await setMode('off');
  });

  // ── A contact share writes its app's data only (0294, A8 matrix F9) ─────

  it('a contact share with Can write changes no item but its app’s data: on refuses, warn reports, off runs', async () => {
    const rw: Who = { ws: [], mod: [], login: '', actor: 'contact:rw', mode: 'rw' };
    const writes: [string, (tx: postgres.TransactionSql) => Promise<{ count: number }>][] = [
      ['an edit', (tx) => tx`update nodes set title = title where id = ${n.note}`],
      ['a delete', (tx) => tx`delete from nodes where id = ${n.note}`],
      ['a grant', (tx) => tx`update item_grants set write = write where node_id = ${n.note}`],
      ['a link', (tx) => tx`update shares set revoked_at = revoked_at where node_id = ${n.note}`],
      [
        'the export stamp',
        (tx) => tx`update app_table_exports set last_write_at = now() where app_node_id = ${n.app}`,
      ],
    ];
    const appData = (tx: postgres.TransactionSql) =>
      tx`update app_databases set size_bytes = size_bytes where app_node_id = ${n.app}`;
    await setMode('on');
    for (const [what, fn] of writes) {
      expect(await attempt(rw, fn, [n.note], sql), what).toMatchObject({
        code: '42501',
        detail: 'ro_actor',
        message: expect.stringContaining('a contact share writes its app'),
      });
    }
    expect(await attempt(rw, appData, [], sql)).toMatchObject({ rows: expect.any(Number) });
    // The brain's own export bookkeeping, as system(app-export), writes.
    const bookkeeping = { ...rw, actor: 'system:app-export' };
    expect(await attempt(bookkeeping, writes[4]![1], [], sql)).toMatchObject({
      rows: expect.any(Number),
    });
    // A contact share without Can write: the read-only refusal, as before.
    expect(
      await attempt({ ...rw, actor: 'contact:ro', mode: 'ro' }, appData, [], sql),
    ).toMatchObject({ code: '42501', detail: 'ro_actor' });
    await setMode('warn');
    const warned = await attempt(rw, writes[0]![1], [n.note], sql);
    expect(warned).toMatchObject({ rows: 1 });
    expect(editMisses(warned)).toHaveLength(1);
    expect(editMisses(await attempt(rw, appData, [], sql))).toEqual([]);
    await setMode('off');
    const off = await attempt(rw, writes[0]![1], [n.note], sql);
    expect(off).toMatchObject({ rows: 1 });
    expect(editMisses(off)).toEqual([]);
  });

  // ── The heads locks filtered by the scope ─────────────────────────────────

  it('the heads locks drop the ids the scope does not read: on drops, warn reports and keeps, off keeps', async () => {
    const held = async () => {
      let out = '';
      const r = await attempt(who.member, async (tx) => {
        await tx`select mantle_lock_heads(${[n.note, n.other]}::uuid[], 'update')`;
        const [h] = await tx<
          { h: string }[]
        >`select current_setting('mantle.heads_held', true) as h`;
        out = h!.h;
        return { count: 1 };
      });
      return { held: out, misses: editMisses(r).length };
    };
    await setMode('off');
    const off = await held();
    expect(off.held).toContain(n.other);
    expect(off.misses).toBe(0);
    await setMode('warn');
    const warn = await held();
    expect(warn.held).toContain(n.other);
    expect(warn.misses).toBe(1);
    await setMode('on');
    const on = await held();
    expect(on.held).toContain(n.note);
    expect(on.held).not.toContain(n.other);
    // A system caller (not the write role) keeps every id.
    let sysHeld = '';
    await attempt(
      { ws: [], mod: [], login: '', actor: 'system:test' },
      async (tx) => {
        await tx`select mantle_lock_heads(${[n.note, n.other]}::uuid[], 'update')`;
        sysHeld = (
          await tx<{ h: string }[]>`select current_setting('mantle.heads_held', true) as h`
        )[0]!.h;
        return { count: 1 };
      },
      [],
      sql,
    );
    expect(sysHeld).toContain(n.other);
    // More heads later are filtered the same way.
    let more = '';
    await attempt(who.member, async (tx) => {
      await tx`select mantle_lock_heads(${[n.note]}::uuid[], 'update')`;
      await tx`select mantle_lock_heads_more(${[n.other, n.page]}::uuid[])`;
      more = (await tx<{ h: string }[]>`select current_setting('mantle.heads_held', true) as h`)[0]!
        .h;
      return { count: 1 };
    });
    expect(more).toContain(n.page);
    expect(more).not.toContain(n.other);
    // A folder's subtree with an item the scope does not read (its grant
    // "Removed here"): the subtree lock takes the rest and ends; it never
    // asks again for the dropped id (no "subtree kept growing").
    const folder = randomUUID();
    const hidden = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${n.note}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path)
               values (${folder}, ${L.owner}, 'branch', ${`${tag} F`}, ${`notes.${tag}f`}::ltree)`;
    });
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${folder}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${folder} and via_folder_id is null`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${folder}, ${ws.H}, true, false), (${folder}, ${ws.W}, false, true)`;
    });
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${folder}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path)
               values (${hidden}, ${L.owner}, 'note', ${`${tag} hidden`}, ${`notes.${tag}f`}::ltree)`;
    });
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${hidden}]::uuid[], 'update')`;
      await tx`update item_grants set excluded = true where node_id = ${hidden} and workspace_id = ${ws.W}`;
    });
    let subtree = '';
    const sub = await attempt(who.member, async (tx) => {
      await tx`select mantle_lock_subtree_heads(${folder}::uuid, '{}'::uuid[])`;
      subtree = (
        await tx<{ h: string }[]>`select current_setting('mantle.heads_held', true) as h`
      )[0]!.h;
      return { count: 1 };
    });
    expect(sub).toMatchObject({ rows: 1 });
    expect(subtree).toContain(folder);
    expect(subtree).not.toContain(hidden);
    await setMode('off');
  });

  // ── nodes: the derived keys and the brain's columns ───────────────────────

  it('a derived key is cleared by an edit, never set; the brain’s columns are refused; an embedding only cleared', async () => {
    await setMode('on');
    const m = who.member;
    expect(
      await attempt(m, (tx) => tx`update nodes set data = data - 'summary' where id = ${n.note}`, [
        n.note,
      ]),
    ).toMatchObject({ rows: 1 });
    expect(
      await attempt(
        m,
        (tx) => tx`update nodes set data = data || '{"rank":"z9"}'::jsonb where id = ${n.note}`,
        [n.note],
      ),
    ).toMatchObject({ rows: 1 });
    expect(
      await attempt(m, (tx) => tx`update nodes set embedding = null where id = ${n.note}`, [
        n.note,
      ]),
    ).toMatchObject({ rows: 1 });
    for (const [what, run] of [
      [
        'a vector',
        (tx: postgres.TransactionSql) =>
          tx`update nodes set embedding = ${VECTOR}::vector where id = ${n.note}`,
      ],
      [
        'derived_mixed',
        (tx: postgres.TransactionSql) =>
          tx`update nodes set derived_mixed = not derived_mixed where id = ${n.note}`,
      ],
      [
        'created_at',
        (tx: postgres.TransactionSql) =>
          tx`update nodes set created_at = now() - interval '1 day' where id = ${n.note}`,
      ],
      [
        'a derived key changed',
        (tx: postgres.TransactionSql) =>
          tx`update nodes set data = data || '{"extract_parked":true}'::jsonb where id = ${n.note}`,
      ],
    ] as const) {
      expect(await attempt(m, run, [n.note]), what).toMatchObject({
        code: '42501',
        message: 'not allowed to change this item: only the brain sets that value',
      });
    }
    // The brain sets them.
    expect(
      await attempt(
        { ws: [], mod: [], login: '', actor: 'system:worker:extract' },
        (tx) =>
          tx`update nodes set data = data || '{"summary":"new"}'::jsonb, embedding = ${VECTOR}::vector where id = ${n.note}`,
        [n.note],
        sql,
      ),
    ).toMatchObject({ rows: 1 });
    await setMode('off');
  });

  // ── Apps: switches (D5) and a new app's code (D4) ─────────────────────────

  it('an app’s tool level lowers to team for an editor, rises only for an Admin user; a new app’s code needs a Moderator', async () => {
    await setMode('on');
    const lower = (p: Who) =>
      attempt(p, (tx) => tx`update apps set author_level = 'team' where node_id = ${n.app}`);
    expect(await lower(who.member)).toMatchObject({ rows: 1 });
    const raise = (p: Who) =>
      attempt(p, async (tx) => {
        await tx`update apps set author_level = 'team' where node_id = ${n.app}`;
        return tx`update apps set author_level = 'admin' where node_id = ${n.app}`;
      });
    expect(await raise(who.homeMod)).toMatchObject({
      code: '42501',
      message: "not allowed to change this app's settings: an Admin user does",
    });
    expect(await raise(who.adminWriter)).toMatchObject({ rows: 1 });
    expect(
      await attempt(
        who.homeMod,
        (tx) => tx`update apps set mcp_access = true where node_id = ${n.app}`,
      ),
    ).toMatchObject({ code: '42501' });
    // A new app (its node made by the brain, homed in H): its code row.
    const fresh = await item('app', [
      [ws.H, true, false],
      [ws.W, false, true],
    ]);
    const insert = (p: Who, level: string) =>
      attempt(p, (tx) => tx`insert into apps (node_id, author_level) values (${fresh}, ${level})`);
    expect(await insert(who.homeMod, 'team')).toMatchObject({ rows: 1 });
    expect(await insert(who.homeMod, 'admin')).toMatchObject({ code: '42501' });
    expect(await insert(who.member, 'team')).toMatchObject({ code: '42501', detail: 'no_edit' });
    await setMode('off');
  });

  // ── Links ─────────────────────────────────────────────────────────────────

  it('a contact share needs an Admin user (its home is not checked), a public link edit', async () => {
    await setMode('on');
    const share = (p: Who, contact: string | null) =>
      attempt(
        p,
        (tx) => tx`insert into shares (token, owner_id, node_id, node_type, contact_id)
                   values (${`${tag}-${randomUUID()}`}, ${L.owner}, ${n.note}, 'note', ${contact})`,
      );
    expect(await share(who.member, null)).toMatchObject({ rows: 1 });
    expect(await share(who.member, n.contact)).toMatchObject({
      code: '42501',
      message: 'not allowed to share this item',
    });
    expect(await share(who.adminWriter, n.contact)).toMatchObject({ rows: 1 });
    await setMode('off');
  });

  // ── The definers of 0281 ──────────────────────────────────────────────────

  it('a renamed map’s cross-map options are rewritten in every map, only for a map the scope may edit', async () => {
    await setMode('on');
    const rename = (p: Who, from: string) =>
      attempt(p, async (tx) => {
        const [r] = await tx<{ n: number }[]>`
          select mantle_recall_retarget(${n.map}, ${from}, ${`${tag}-uno`}) as n`;
        const [after] = await sql<{ o: string }[]>`
          select options::text as o from recall_nodes where map_id = ${n.map2}`;
        // Read on another connection: nothing committed yet.
        expect(after!.o).toContain(`${tag}-one`);
        // The map itself took the new slug in the definer (fix round 1, L1),
        // its old one kept as a former slug.
        const [m] = await tx<{ slug: string; former: string[] }[]>`
          select slug, former_slugs as former from recall_maps where id = ${n.map}`;
        expect(m).toEqual({ slug: `${tag}-uno`, former: [`${tag}-one`] });
        return { count: r!.n };
      });
    // The Write grant user edits map one; map two is outside its scope.
    expect(await rename(who.member, `${tag}-one`)).toMatchObject({ rows: 1 });
    expect(await rename(who.outsider, `${tag}-one`)).toMatchObject({
      code: '42501',
      detail: 'no_edit',
    });
    expect(await rename(who.member, 'not-its-slug')).toMatchObject({ code: '22023' });
    // A write-role caller with no scope is refused (fix round 1, L2).
    const noScope: Who = { ws: [], mod: [], login: '', actor: `login:rw:${L.member}` };
    expect(await rename(noScope, `${tag}-one`)).toMatchObject({ code: '42501' });
    await setMode('off');
  });

  it('a secret’s sealed value goes through the definer, only for a secret the scope may edit', async () => {
    await setMode('on');
    const put = (p: Who, node: string) =>
      attempt(p, async (tx) => {
        await tx`select mantle_secret_put(${node}, ${Buffer.from('sealed')}::bytea, 1)`;
        return { count: 1 };
      });
    expect(await put(who.member, n.secret)).toMatchObject({ code: '42501' });
    // A write-role caller with no scope is refused (fix round 1, L2).
    expect(
      await put({ ws: [], mod: [], login: '', actor: `login:rw:${L.owner}` }, n.secret),
    ).toMatchObject({ code: '42501' });
    expect(await put(who.member, n.note)).toMatchObject({ code: '22023' });
    // The owner, a Moderator of Admin, edits the secret.
    expect(await put(who.owner, n.secret)).toMatchObject({ rows: 1 });
    // The role itself holds no right on secrets.
    expect(
      await attempt(
        who.owner,
        (tx) => tx`insert into secrets (node_id, ciphertext) values (${n.secret}, '\\x00'::bytea)`,
      ),
    ).toMatchObject({ code: '42501', message: 'permission denied for table secrets' });
    await setMode('off');
  });

  // ── Fix round 1 ───────────────────────────────────────────────────────────

  /** A folder at the notes root, homed in H with Write to W. */
  const folderAt = async (label: string): Promise<string> => {
    const id = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into nodes (id, owner_id, type, title, path)
               values (${id}, ${L.owner}, 'branch', ${`${tag} ${label}`}, ${`notes.${tag}${label}`}::ltree)`;
    });
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${id}, ${ws.H}, true, false), (${id}, ${ws.W}, false, true)`;
    });
    return id;
  };

  it('M1: a new node’s brain-only values (derived keys, an embedding) are dropped when on, reported in warn, kept in off and for the brain', async () => {
    const folder = await folderAt('ins');
    const make = (p: Who, pool = w) =>
      attempt(
        p,
        async (tx) => {
          const [row] = await tx<{ summary: boolean; text: boolean; rank: string; emb: boolean }[]>`
            insert into nodes (owner_id, type, title, path, data, embedding)
            values (${L.owner}, 'note', ${`${tag} forged`}, ${`notes.${tag}ins`}::ltree,
                    '{"summary":"forged","text":"forged","extract_completed_at":"2026-01-01","rank":"a1"}'::jsonb,
                    ${VECTOR}::vector)
            returning data ? 'summary' as summary, data ? 'text' as text, data->>'rank' as rank,
                      embedding is not null as emb`;
          return { count: 1, ...row! } as never;
        },
        [folder],
        pool,
      );
    const kept = { summary: true, text: true, rank: 'a1', emb: true };
    await setMode('off');
    let r = (await make(who.member)) as Result & Record<string, unknown>;
    expect(r).toMatchObject({ rows: 1 });
    expect(editMisses(r)).toEqual([]);
    await setMode('warn');
    r = (await make(who.member)) as Result & Record<string, unknown>;
    expect(editMisses(r).length).toBe(1);
    await setMode('on');
    const stripped = await attempt(
      who.member,
      async (tx) => {
        const [row] = await tx<{ summary: boolean; text: boolean; rank: string; emb: boolean }[]>`
          insert into nodes (owner_id, type, title, path, data, embedding)
          values (${L.owner}, 'note', ${`${tag} forged`}, ${`notes.${tag}ins`}::ltree,
                  '{"summary":"forged","text":"forged","extract_completed_at":"2026-01-01","rank":"a1"}'::jsonb,
                  ${VECTOR}::vector)
          returning data ? 'summary' as summary, data ? 'text' as text, data->>'rank' as rank,
                    embedding is not null as emb`;
        expect(row).toEqual({ summary: false, text: false, rank: 'a1', emb: false });
        return { count: 1 };
      },
      [folder],
    );
    expect(stripped).toMatchObject({ rows: 1 });
    // The brain's own create keeps them.
    const brain = await attempt(
      { ws: [], mod: [], login: '', actor: 'system:worker:extract' },
      async (tx) => {
        const [row] = await tx<{ summary: boolean; text: boolean; rank: string; emb: boolean }[]>`
          insert into nodes (owner_id, type, title, path, data, embedding)
          values (${L.owner}, 'note', ${`${tag} brain`}, ${`notes.${tag}ins`}::ltree,
                  '{"summary":"s","text":"t","rank":"a1"}'::jsonb, ${VECTOR}::vector)
          returning data ? 'summary' as summary, data ? 'text' as text, data->>'rank' as rank,
                    embedding is not null as emb`;
        expect(row).toEqual(kept);
        return { count: 1 };
      },
      [folder],
      sql,
    );
    expect(brain).toMatchObject({ rows: 1 });
    await setMode('off');
  });

  it('M2: the switches take a number of tries; a busy table fails with nothing changed, and the switch goes when it is free', async () => {
    const hold = postgres(scratch!.url, { max: 1, prepare: false, onnotice: () => {} });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = hold.begin(async (tx) => {
      await tx`lock table pages in row exclusive mode`;
      locked();
      await held;
    });
    await isLocked;
    await expect(sql`select mantle_set_edit_check('warn', 2)`).rejects.toMatchObject({
      code: '55P03',
    });
    const [m] = await sql<{ m: string; on: number }[]>`
      select mantle_check_box_mode('edit_check') as m,
             (select count(*) filter (where enabled)::int from mantle_edit_check_tables()) as on`;
    expect(m).toEqual({ m: 'off', on: 0 });
    release();
    await holder;
    await hold.end();
    await sql`select mantle_set_edit_check('warn', 2)`;
    expect((await sql<{ m: string }[]>`select mantle_edit_check_mode() as m`)[0]!.m).toBe('warn');
    await setMode('off');
    // The actor check's setter takes the same (and one argument still works).
    await sql`select mantle_set_actor_check('off', 3)`;
    await sql`select mantle_set_actor_check('off')`;
  });

  it('the floor (0301): lowering a check needs a reason, is recorded and warned; raising both to on clears the record', async () => {
    const box = async () =>
      (
        await sql<{ a: string; e: string; l: string }[]>`
          select mantle_check_box_mode('actor_check') as a,
                 mantle_check_box_mode('edit_check') as e,
                 mantle_check_lowered() as l`
      )[0]!;
    const warnings: string[] = [];
    const quiet = postgres(scratch!.url, {
      max: 1,
      prepare: false,
      onnotice: (n: { message?: string; severity?: string }) => {
        if (n.severity === 'WARNING') warnings.push(String(n.message ?? ''));
      },
    });
    try {
      // Raising needs no reason, from any mode.
      await quiet`select mantle_set_actor_check('warn')`;
      await quiet`select mantle_set_actor_check('on')`;
      await quiet`select mantle_set_edit_check('on')`;
      expect(await box()).toEqual({ a: 'on', e: 'on', l: '' });
      // Lowering with no reason (or a blank one) is refused, nothing changed.
      for (const q of [
        () => quiet`select mantle_set_edit_check('warn')`,
        () => quiet`select mantle_set_edit_check('off', 50, '  ')`,
        () => quiet`select mantle_set_check('actor_check', 'off')`,
      ]) {
        await expect(q()).rejects.toMatchObject({
          code: '42501',
          message: expect.stringMatching(
            /^mantle_set_check: lowering mantle\.\w+ from on to \w+ needs a reason$/,
          ),
          hint: expect.stringContaining('docs/update-prod.md'),
        });
      }
      expect(await box()).toEqual({ a: 'on', e: 'on', l: '' });
      expect(
        (
          await sql<{ n: number }[]>`
          select count(*) filter (where not enabled)::int as n from mantle_edit_check_tables()`
        )[0]!.n,
      ).toBe(0);
      // With a reason: lowered, warned (the server log) and recorded.
      await quiet`select mantle_set_edit_check('warn', 50, 'a stuck import, ticket 7')`;
      const after = await box();
      expect(after).toMatchObject({ a: 'on', e: 'warn' });
      expect(after.l).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ mantle\.edit_check on to warn by \S+: a stuck import, ticket 7$/,
      );
      expect(
        warnings.some((w) =>
          /^mantle check lowered: mantle\.edit_check from on to warn by /.test(w),
        ),
      ).toBe(true);
      // Warn to off is lowering too; the record names the latest.
      await expect(quiet`select mantle_set_edit_check('off')`).rejects.toMatchObject({
        code: '42501',
      });
      await quiet`select mantle_set_edit_check('off', 50, 'still stuck')`;
      expect((await box()).l).toMatch(/mantle\.edit_check warn to off by \S+: still stuck$/);
      // One check back on keeps the record; both on clears it.
      await quiet`select mantle_set_edit_check('warn')`;
      expect((await box()).l).not.toBe('');
      await quiet`select mantle_set_edit_check('on')`;
      expect(await box()).toEqual({ a: 'on', e: 'on', l: '' });
    } finally {
      await quiet`select mantle_set_edit_check('off', 50, 'test')`;
      await quiet`select mantle_set_actor_check('off', 50, 'test')`;
      await quiet.end();
    }
    expect(await box()).toMatchObject({ a: 'off', e: 'off' });
  });

  it('M3: a folder rename or move takes every row below it, those the mover cannot read too; a delete that would leave them is counted', async () => {
    await setMode('on');
    const folder = await folderAt('mv');
    const seen = await item('note', HWgrants());
    const hidden = randomUUID();
    for (const [id, title] of [
      [seen, 'seen'],
      [hidden, 'hidden'],
    ] as const) {
      await sql.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`select mantle_lock_heads(array[${folder}]::uuid[], 'share')`;
        if (id === hidden) {
          await tx`insert into nodes (id, owner_id, type, title, path)
                   values (${id}, ${L.owner}, 'note', ${`${tag} ${title}`}, ${`notes.${tag}mv`}::ltree)`;
        } else {
          await tx`update nodes set path = ${`notes.${tag}mv`}::ltree where id = ${id}`;
        }
      });
    }
    // The hidden note: homed in O, the folder's grants "Removed here".
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${hidden}]::uuid[], 'update')`;
      await tx`update item_grants set excluded = true, is_home = false, write = false
               where node_id = ${hidden}`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${hidden}, ${ws.O}, true, false)`;
    });
    const move = (p: Who) =>
      attempt(p, async (tx) => {
        await tx`select mantle_lock_subtree_heads(${folder}::uuid, '{}'::uuid[])`;
        const [r] = await tx<{ n: number }[]>`
          select mantle_subtree_rewrite(${L.owner}, ${`notes.${tag}mv`}::ltree, ${`notes.${tag}mv2`}::ltree) as n`;
        // Every row moved: the folder, the note it reads, the one it cannot
        // (the one rule now refuses the new path: the hidden row is there).
        await tx`savepoint h`;
        const here = await tx`
          select mantle_subtree_refuse_hidden(${L.owner}, ${`notes.${tag}mv2`}::ltree)`.then(
          () => null,
          (e: { detail?: string }) => e.detail ?? 'refused',
        );
        await tx`rollback to savepoint h`;
        expect(here).toBe('hidden_rows');
        return { count: r!.n };
      });
    // A rename (the same parent): every row moves, the hidden one too.
    expect(await move(who.homeMod)).toMatchObject({ rows: 3 });
    // A move (a new parent) of a folder holding a row the mover cannot read:
    // refused, the owner's rule (fix round 2), detail hidden_rows (a 409).
    const dest = await folderAt('dst');
    const reparent = await attempt(who.homeMod, async (tx) => {
      await tx`select mantle_lock_subtree_heads(${folder}::uuid, array[${dest}]::uuid[])`;
      const [r] = await tx<{ n: number }[]>`
        select mantle_subtree_rewrite(${L.owner}, ${`notes.${tag}mv`}::ltree,
                                      ${`notes.${tag}dst.${tag}mv`}::ltree) as n`;
      return { count: r!.n };
    });
    expect(reparent).toMatchObject({
      code: '42501',
      detail: 'hidden_rows',
      message: 'This folder holds items you cannot move.',
    });
    // A Write grant (no Moderator of the home) renames it (the owner's
    // rule, S11a-6a, migration 0305: a rename is an edit of the folder),
    // every row with it; a move (a new parent) stays manage: refused.
    expect(await move(who.member)).toMatchObject({ rows: 3 });
    expect(
      await attempt(who.member, async (tx) => {
        await tx`select mantle_lock_subtree_heads(${folder}::uuid, array[${dest}]::uuid[])`;
        const [r] = await tx<{ n: number }[]>`
          select mantle_subtree_rewrite(${L.owner}, ${`notes.${tag}mv`}::ltree,
                                        ${`notes.${tag}dst.${tag}mv`}::ltree) as n`;
        return { count: r!.n };
      }),
    ).toMatchObject({ code: '42501', message: 'not allowed to move this item' });
    // A folder holding an app, moved into a folder that adds a workspace the
    // mover does not moderate (O): every app inside is held to the placement
    // rule, not only a moved app (fix round 2). Staged: off moves, on
    // refuses.
    const box = await folderAt('box');
    const app = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${box}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path)
               values (${app}, ${L.owner}, 'app', ${`${tag} boxed app`}, ${`notes.${tag}box`}::ltree)`;
    });
    const wide = await folderAt('wide');
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${wide}]::uuid[], 'update')`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${wide}, ${ws.O}, false, false)`;
    });
    const intoWide = () =>
      attempt(who.homeMod, async (tx) => {
        await tx`select mantle_lock_subtree_heads(${box}::uuid, array[${wide}]::uuid[])`;
        const [r] = await tx<{ n: number }[]>`
          select mantle_subtree_rewrite(${L.owner}, ${`notes.${tag}box`}::ltree,
                                        ${`notes.${tag}wide.${tag}box`}::ltree) as n`;
        return { count: r!.n };
      });
    expect(await intoWide()).toMatchObject({
      code: '42501',
      message: 'placing this app adds a workspace you do not moderate',
    });
    // A rename of that folder (the same parent) asks nothing (N2).
    expect(
      await attempt(who.homeMod, async (tx) => {
        await tx`select mantle_lock_subtree_heads(${box}::uuid, '{}'::uuid[])`;
        const [r] = await tx<{ n: number }[]>`
          select mantle_subtree_rewrite(${L.owner}, ${`notes.${tag}box`}::ltree,
                                        ${`notes.${tag}box9`}::ltree) as n`;
        return { count: r!.n };
      }),
    ).toMatchObject({ rows: 2 });
    // An app "Removed here" from O: the move does not add O to it, so the
    // move asks nothing of O, in on (no refusal) and in warn (no miss).
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${app}]::uuid[], 'update')`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write, excluded)
               values (${app}, ${ws.O}, false, false, true)`;
    });
    expect(await intoWide()).toMatchObject({ rows: 2 });
    await setMode('warn');
    const warned = await intoWide();
    expect(warned).toMatchObject({ rows: 2 });
    expect(editMisses(warned)).toEqual([]);
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${app}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${app} and workspace_id = ${ws.O}`;
    });
    await setMode('off');
    expect(await intoWide()).toMatchObject({ rows: 2 });
    await setMode('on');
    // A folder holding an app moved to the tree's top level (round 4, L1):
    // a kind's root row passes no grants, so nothing is added: no refusal
    // in on, no miss in warn.
    const outer = await folderAt('out');
    const inner = randomUUID();
    const app3 = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${outer}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path)
               values (${inner}, ${L.owner}, 'branch', ${`${tag} in`}, ${`notes.${tag}out.${tag}in`}::ltree)`;
    });
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${inner}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path)
               values (${app3}, ${L.owner}, 'app', ${`${tag} inner app`}, ${`notes.${tag}out.${tag}in`}::ltree)`;
    });
    const toTop = () =>
      attempt(who.homeMod, async (tx) => {
        await tx`select mantle_lock_subtree_heads(${inner}::uuid, '{}'::uuid[])`;
        const [r] = await tx<{ n: number }[]>`
          select mantle_subtree_rewrite(${L.owner}, ${`notes.${tag}out.${tag}in`}::ltree,
                                        ${`notes.${tag}in`}::ltree) as n`;
        return { count: r!.n };
      });
    expect(await toTop()).toMatchObject({ rows: 2 });
    await setMode('warn');
    const topWarn = await toTop();
    expect(topWarn).toMatchObject({ rows: 2 });
    expect(editMisses(topWarn)).toEqual([]);
    await setMode('on');
    // Off the write role nothing is hidden.
    const [sys] = await sql<{ n: number }[]>`
      select mantle_subtree_hidden(${L.owner}, ${`notes.${tag}mv`}::ltree) as n`;
    expect(sys!.n).toBe(0);
    await setMode('off');
  });

  // ── Migrate's sync and the coverage ───────────────────────────────────────

  it('migrate makes the matrix’s triggers once; a new one follows the box mode; a stray one goes', async () => {
    const triggers = async () =>
      sql<{ t: string; name: string; oid: number; on: boolean }[]>`
        select tg.tgrelid::regclass::text as t, tg.tgname::text as name, tg.oid::int as oid,
               tg.tgenabled <> 'D' as on
          from pg_trigger tg
         where tg.tgname like 'mantle\\_edit\\_check\\_%'
           and tg.tgname not in ('mantle_edit_check_ro', 'mantle_edit_check_contact')
         order by 1, 2`;
    const before = await triggers();
    await syncWriteRoleRules(sql);
    expect(await triggers()).toEqual(before);
    // Each table's triggers are the matrix's, on the live columns.
    for (const t of ACCESS_MATRIX.filter((x) => x.editCheck)) {
      const cols = await sql<{ c: string; text: boolean }[]>`
        select a.attname::text as c, tn.nspname <> 'pg_catalog' as text from pg_attribute a
          join pg_type ty on ty.oid = a.atttypid join pg_namespace tn on tn.oid = ty.typnamespace
         where a.attrelid = ${t.table}::regclass and a.attnum > 0 and not a.attisdropped
           and a.attgenerated = '' order by a.attnum`;
      const want = editCheckTriggers(
        t,
        cols.map((r) => r.c),
        new Set(cols.filter((r) => r.text).map((r) => r.c)),
      )
        .map((x) => x.name)
        .sort();
      const live = before
        .filter((r) => r.t === t.table.replace(/^public\./, ''))
        .map((r) => r.name);
      expect(live, t.table).toEqual(want);
    }
    // Dropped by hand, made again: disabled on an off box, enabled on warn.
    await sql`drop trigger mantle_edit_check_manage on pages`;
    await syncWriteRoleRules(sql);
    const offNow = (await triggers()).find((r) => r.t === 'pages')!;
    expect(offNow.on).toBe(false);
    await setMode('warn');
    await sql`drop trigger mantle_edit_check_manage on pages`;
    await syncWriteRoleRules(sql);
    expect((await triggers()).find((r) => r.t === 'pages')!.on).toBe(true);
    await setMode('off');
    // A trigger with the family's name the matrix does not want goes.
    await sql`create trigger mantle_edit_check_stray before update on pages for each row
              execute function mantle_edit_check_trg('edit', 'node_id', '', '')`;
    await syncWriteRoleRules(sql);
    expect((await triggers()).some((r) => r.name === 'mantle_edit_check_stray')).toBe(false);
  });

  it('coverage: every item table but the heads rows has the read-only refusal, and the contact share’s but its app’s data; the derived keys are one list', async () => {
    const rows = await sql<{ t: string; ro: boolean; contact: boolean }[]>`
      select c.tbl::text as t,
             exists (select 1 from pg_trigger g where g.tgrelid = c.tbl
                        and g.tgname = 'mantle_edit_check_ro') as ro,
             exists (select 1 from pg_trigger g where g.tgrelid = c.tbl
                        and g.tgname = 'mantle_edit_check_contact') as contact
        from mantle_actor_check_tables() c`;
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect([r.t, r.ro]).toEqual([r.t, r.t !== 'node_acl_head']);
      expect([r.t, r.contact]).toEqual([r.t, !['node_acl_head', 'app_databases'].includes(r.t)]);
    }
    // One loop installs both (0294): re-run, it replaces each in place, and a
    // replaced trigger follows the box mode (off here: none left enabled).
    const migrationMade = async () =>
      sql<{ n: number; enabled: number }[]>`
        select count(*)::int as n, count(*) filter (where tgenabled <> 'D')::int as enabled
          from pg_trigger
         where tgname in ('mantle_edit_check_ro', 'mantle_edit_check_contact')`;
    const [was] = await migrationMade();
    const [made] = await sql<{ n: number }[]>`select mantle_edit_check_item_triggers() as n`;
    expect(made!.n).toBe(rows.filter((r) => r.ro).length + rows.filter((r) => r.contact).length);
    expect((await migrationMade())[0]).toEqual({ n: was!.n, enabled: 0 });
    const [k] = await sql<{ keys: string[] }[]>`select mantle_node_derived_keys() as keys`;
    expect([...k!.keys].sort()).toEqual([...NODE_DERIVED_KEYS].sort());
    // The rule written once: the scope forms are the array forms.
    const [f] = await sql<{ e: boolean; m: boolean }[]>`
      select mantle_may_edit_in(array[${ws.W}]::uuid[], '{}'::uuid[], ${ws.H}::uuid, array[${ws.W}]::uuid[]) as e,
             mantle_may_manage_in(array[${ws.H}]::uuid[], ${ws.H}::uuid) as m`;
    expect(f).toEqual({ e: true, m: true });
  });
});
