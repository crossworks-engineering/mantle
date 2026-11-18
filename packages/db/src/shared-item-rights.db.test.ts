/**
 * Shared items in a workspace (migration 0382; the owner's rule, dev-brain
 * page "Permissions", 2026-11-18), on a real login of the write role with
 * both checks on. An item granted to workspace W (not its home), for a
 * login in W:
 *
 *  - a Moderator of W: read, create and upload in it (items and folders),
 *    write, move it inside W, Write on or off; no delete, no home move;
 *  - a user of W: read; write with Write on; nothing more;
 *  - a Moderator of its home: everything, as before;
 *  - an Admin user (a Moderator of Admin): a Moderator of the home of every
 *    item it reads, so manage and edit, delete and home move included, and
 *    nothing on an item it does not read (owner page d7313c67, decision A,
 *    2026-11-18).
 *
 * The fixture is the real case: folders homed in Admin and granted to a
 * project workspace W, whose Moderators could not move or file into them.
 * The Admin user here is a Moderator of Admin (always) and a plain user of
 * W; its rights on these items come from the home. Items homed in another
 * workspace X show what an Admin user gets from Admin alone: on one it reads
 * through W (Write on or off), what X's Moderator gets; on one X alone
 * holds, which it does not read, nothing (not found, no manage).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/db/src/shared-item-rights.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';
import { viewerDatabaseUrl, viewerRolePassword } from './viewer';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

class Rollback extends Error {}

type Who = { ws: string[]; mod: string[]; login: string };
/** A write's answer: the rows it changed, or refused. */
type Answer = number | 'refused';

describe.skipIf(!URL)('shared items in a workspace (0382)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let w: ReturnType<typeof postgres>;
  const testKey = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
  const tag = `sr${randomUUID().slice(0, 6)}`;
  const L = {
    owner: randomUUID(),
    admin: randomUUID(),
    modW: randomUUID(),
    userW: randomUUID(),
    modX: randomUUID(),
    outsider: randomUUID(),
  };
  type Role = Exclude<keyof typeof L, 'owner'>;
  const ws = { admin: '', W: '', X: '', T: '', V: '' };
  /** Folders (in the notes tree) and one note in each of the first four. */
  const f = {
    on: '',
    onDest: '',
    off: '',
    offDest: '',
    out: '',
    x: '',
    xoff: '',
    xonly: '',
    home: '',
  };
  const n = { on: '', off: '', x: '', xoff: '', xonly: '', home: '' };
  /** A subfolder of `on` and of `off`, for a folder move. */
  const sub = { on: '', off: '' };
  const who = {} as Record<Role, Who>;
  const path = (label: string) => `notes.${tag}${label}`;

  /** Make a node as system work; a folder's grants are `grants` ([ws, home,
   *  write]), an item takes its folder's. */
  const node = async (
    type: 'branch' | 'note',
    at: string,
    grants: [string, boolean, boolean][] | null,
  ): Promise<string> => {
    const id = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into nodes (id, owner_id, type, title, path)
               values (${id}, ${L.owner}, ${type}, ${`${tag} ${at}`}, ${at}::ltree)`;
    });
    if (grants) {
      await sql.begin(async (tx) => {
        await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
        await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
        for (const [wsId, home, write] of grants) {
          await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                   values (${id}, ${wsId}, ${home}, ${write})`;
        }
      });
    }
    return id;
  };

  /** Run `fn` as `p` on the write role, both checks on, and roll back. */
  const attempt = async (
    p: Who,
    heads: string[],
    fn: (tx: postgres.TransactionSql) => Promise<number>,
  ): Promise<Answer> => {
    let out: Answer | null = null;
    await w
      .begin(async (tx) => {
        await tx`select set_config('mantle.ws', ${`{${p.ws.join(',')}}`}, true),
                        set_config('mantle.mod_ws', ${`{${p.mod.join(',')}}`}, true),
                        set_config('mantle.login_id', ${p.login}, true),
                        set_config('mantle.actor', ${`login:rw:${p.login}`}, true),
                        set_config('mantle.write_mode', 'rw', true),
                        set_config('mantle.actor_check', 'on', true),
                        set_config('mantle.edit_check', 'on', true)`;
        if (heads.length > 0) await tx`select mantle_lock_heads(${heads}::uuid[], 'update')`;
        try {
          out = await fn(tx);
        } catch (err) {
          if ((err as { code?: string }).code !== '42501') throw err;
          out = 'refused';
        }
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
    return out!;
  };

  type Acts = {
    read: Answer;
    edit: Answer;
    create: Answer;
    mkdir: Answer;
    moveIn: Answer;
    moveOut: Answer;
    folderMoveIn: Answer;
    delete: Answer;
    moveHome: Answer;
  };

  /** Every act of the rule table, by `role`, on the note in `from` (moving
   *  it to `to`, a folder W holds too, or out of W). */
  const acts = async (
    role: Role,
    item: string,
    from: string,
    fromPath: string,
    to: string,
    toPath: string,
    subId: string,
    subLabel: string,
  ): Promise<Acts> => {
    const p = who[role];
    const count = (r: { count: number }) => r.count;
    return {
      read: await attempt(p, [], async (tx) =>
        count(await tx`select 1 from nodes where id = ${item}`),
      ),
      edit: await attempt(p, [item], async (tx) =>
        count(await tx`update nodes set title = ${`${tag} edited`} where id = ${item}`),
      ),
      create: await attempt(p, [from], async (tx) =>
        count(
          await tx`insert into nodes (owner_id, type, title, path)
                   values (${L.owner}, 'note', ${`${tag} new`}, ${fromPath}::ltree)`,
        ),
      ),
      mkdir: await attempt(p, [from], async (tx) =>
        count(
          await tx`insert into nodes (owner_id, type, title, path)
                   values (${L.owner}, 'branch', ${`${tag} dir`}, ${`${fromPath}.made`}::ltree)`,
        ),
      ),
      moveIn: await attempt(p, [item, from, to], async (tx) =>
        count(await tx`update nodes set path = ${toPath}::ltree where id = ${item}`),
      ),
      moveOut: await attempt(p, [item, from, f.out], async (tx) =>
        count(await tx`update nodes set path = ${path('out')}::ltree where id = ${item}`),
      ),
      folderMoveIn: await attempt(p, [], async (tx) => {
        await tx`select mantle_lock_subtree_heads(${subId}::uuid, array[${from}, ${to}]::uuid[])`;
        const [r] = await tx<{ n: number }[]>`
          select mantle_subtree_rewrite(${L.owner}, ${`${fromPath}.${subLabel}`}::ltree,
                                        ${`${toPath}.${subLabel}`}::ltree) as n`;
        return r!.n;
      }),
      delete: await attempt(p, [item], async (tx) =>
        count(await tx`delete from nodes where id = ${item}`),
      ),
      moveHome: await attempt(p, [item], async (tx) => {
        await tx`select mantle_grant_move_home(${item}::uuid, ${ws.T}::uuid, false, ${p.login}::uuid)`;
        return 1;
      }),
    };
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    w = postgres(viewerDatabaseUrl(scratch.url, 'write', viewerRolePassword(testKey, 'write')), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    await sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${L.owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${L.admin}, ${`${tag}-a@example.invalid`}, 'x', false, 'admin', 'Admin user'),
      (${L.modW}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Moderator of W'),
      (${L.userW}, ${`${tag}-u@example.invalid`}, 'x', false, 'member', 'User of W'),
      (${L.modX}, ${`${tag}-x@example.invalid`}, 'x', false, 'member', 'Moderator of X'),
      (${L.outsider}, ${`${tag}-v@example.invalid`}, 'x', false, 'member', 'Outsider')`;
    await sql`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
      on conflict (id) do nothing`;
    await sql`select * from mantle_ws_migrate()`;
    ws.admin = (
      await sql<{ id: string }[]>`select id::text as id from workspaces
        where owner_id = ${L.owner} and is_admin`
    )[0]!.id;
    await sql`insert into workspace_users (workspace_id, login_id, moderator)
              values (${ws.admin}, ${L.admin}, true) on conflict do nothing`;
    for (const [key, seats] of [
      [
        'W',
        [
          [L.admin, false],
          [L.modW, true],
          [L.userW, false],
        ],
      ],
      ['X', [[L.modX, true]]],
      // The home move's target: every role moderates it, so only the
      // home's manage decides.
      [
        'T',
        [
          [L.admin, true],
          [L.modW, true],
          [L.userW, true],
        ],
      ],
      ['V', [[L.outsider, true]]],
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
    // Team holds none of them here.
    await sql`delete from workspace_users u using workspaces w
               where w.id = u.workspace_id and w.name = 'Team' and not w.is_admin
                 and u.login_id in (${L.modW}, ${L.userW}, ${L.modX}, ${L.outsider})`;
    for (const k of Object.keys(L).filter((x) => x !== 'owner') as Role[]) {
      const [s] = await sql<{ ws: string[]; mod: string[] }[]>`
        select coalesce(array_agg(u.workspace_id::text), '{}') as ws,
               coalesce(array_agg(u.workspace_id::text) filter (where u.moderator), '{}') as mod
          from workspace_users u join workspaces w on w.id = u.workspace_id and w.archived_at is null
         where u.login_id = ${L[k]}`;
      who[k] = { ws: s!.ws, mod: s!.mod, login: L[k] };
    }
    await node('branch', 'notes', null).catch(() => '');
    const A = ws.admin;
    f.on = await node('branch', path('on'), [
      [A, true, false],
      [ws.W, false, true],
    ]);
    f.onDest = await node('branch', path('ondest'), [
      [A, true, false],
      [ws.W, false, true],
    ]);
    f.off = await node('branch', path('off'), [
      [A, true, false],
      [ws.W, false, false],
    ]);
    f.offDest = await node('branch', path('offdest'), [
      [A, true, false],
      [ws.W, false, false],
    ]);
    f.out = await node('branch', path('out'), [[A, true, false]]);
    f.x = await node('branch', path('x'), [
      [ws.X, true, false],
      [ws.W, false, true],
    ]);
    // Homed in X, granted to W with Write off; and X's alone (the Admin
    // user does not read it).
    f.xoff = await node('branch', path('xoff'), [
      [ws.X, true, false],
      [ws.W, false, false],
    ]);
    f.xonly = await node('branch', path('xonly'), [[ws.X, true, false]]);
    // W's own folder, its home's Write on: today's rules.
    f.home = await node('branch', path('home'), [[ws.W, true, true]]);
    n.on = await node('note', path('on'), null);
    n.off = await node('note', path('off'), null);
    n.x = await node('note', path('x'), null);
    n.xoff = await node('note', path('xoff'), null);
    n.xonly = await node('note', path('xonly'), null);
    n.home = await node('note', path('home'), null);
    sub.on = await node('branch', `${path('on')}.s`, null);
    sub.off = await node('branch', `${path('off')}.s`, null);
    // Both checks on for the box (its triggers enabled), after the fixture.
    await sql`select mantle_set_actor_check('on', 50, 'test')`;
    await sql`select mantle_set_edit_check('on', 50, 'test')`;
  }, 240_000);

  afterAll(async () => {
    await w?.end();
    await sql?.end();
    await scratch?.drop();
  });

  it('the fixture: notes and subfolders take their folder’s grants', async () => {
    const rows = await sql<{ id: string; read: string[]; write: string[]; home: string }[]>`
      select id::text as id, read_ws::text[] as read, write_ws::text[] as write, home_ws::text as home
        from nodes where id = any(${[n.on, n.off, sub.on, n.x, n.home, f.home]}::uuid[])`;
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get(n.on)).toMatchObject({ home: ws.admin, write: [ws.W] });
    expect(by.get(n.on)!.read.sort()).toEqual([ws.admin, ws.W].sort());
    expect(by.get(n.off)).toMatchObject({ home: ws.admin, write: [] });
    expect(by.get(sub.on)!.read.sort()).toEqual([ws.admin, ws.W].sort());
    expect(by.get(n.x)).toMatchObject({ home: ws.X, write: [ws.W] });
    // W's own folder has its home's Write on; a note made in it is homed in
    // W (its own home row, Write off).
    expect(by.get(f.home)).toMatchObject({ home: ws.W, write: [ws.W] });
    expect(by.get(n.home)).toMatchObject({ home: ws.W, write: [] });
  });

  const Y = 1;
  const NO: Answer = 'refused';

  it('Write on: the rule table, by role (homed in Admin, granted to W)', async () => {
    const run = (r: Role) => acts(r, n.on, f.on, path('on'), f.onDest, path('ondest'), sub.on, 's');
    // The home's Moderator (an Admin user: Admin is the home): everything.
    expect(await run('admin')).toEqual({
      read: Y,
      edit: Y,
      create: Y,
      mkdir: Y,
      moveIn: Y,
      moveOut: Y,
      folderMoveIn: 1,
      delete: Y,
      moveHome: Y,
    });
    // A Moderator of W: read, create, write, move inside W.
    expect(await run('modW')).toEqual({
      read: Y,
      edit: Y,
      create: Y,
      mkdir: Y,
      moveIn: Y,
      moveOut: NO,
      folderMoveIn: 1,
      delete: NO,
      moveHome: NO,
    });
    // A user of W, Write on: read and write only (no create: the owner's
    // rule takes away the add a shared Write gave).
    expect(await run('userW')).toEqual({
      read: Y,
      edit: Y,
      create: NO,
      mkdir: NO,
      moveIn: NO,
      moveOut: NO,
      folderMoveIn: NO,
      delete: NO,
      moveHome: NO,
    });
    // Outside W: nothing (an item it does not read matches no row).
    const outsider = await run('outsider');
    expect(outsider).toMatchObject({ read: 0, edit: 0, create: NO, mkdir: NO, delete: 0 });
    expect([0, NO]).toContain(outsider.moveIn);
    expect([0, NO]).toContain(outsider.folderMoveIn);
    expect(outsider.moveHome).toBe(NO);
  });

  it('Write off: the rule table, by role (the switch does not matter to a Moderator)', async () => {
    const run = (r: Role) =>
      acts(r, n.off, f.off, path('off'), f.offDest, path('offdest'), sub.off, 's');
    expect(await run('admin')).toEqual({
      read: Y,
      edit: Y,
      create: Y,
      mkdir: Y,
      moveIn: Y,
      moveOut: Y,
      folderMoveIn: 1,
      delete: Y,
      moveHome: Y,
    });
    expect(await run('modW')).toEqual({
      read: Y,
      edit: Y,
      create: Y,
      mkdir: Y,
      moveIn: Y,
      moveOut: NO,
      folderMoveIn: 1,
      delete: NO,
      moveHome: NO,
    });
    expect(await run('userW')).toEqual({
      read: Y,
      edit: NO,
      create: NO,
      mkdir: NO,
      moveIn: NO,
      moveOut: NO,
      folderMoveIn: NO,
      delete: NO,
      moveHome: NO,
    });
  });

  it('a move inside W needs W to hold where it lands: a Write-off item into a Write-on folder, and out', async () => {
    // From a Write-off folder into a Write-on one, both held by W.
    expect(
      await attempt(
        who.modW,
        [n.off, f.off, f.onDest],
        async (tx) =>
          (await tx`update nodes set path = ${path('ondest')}::ltree where id = ${n.off}`).count,
      ),
    ).toBe(1);
    // To the kind's top level (no folder): a move out of W, manage only.
    expect(
      await attempt(
        who.modW,
        [n.on, f.on],
        async (tx) => (await tx`update nodes set path = 'notes'::ltree where id = ${n.on}`).count,
      ),
    ).toBe(NO);
  });

  it('an item homed in another workspace X, granted to W: its home’s Moderator and W’s', async () => {
    const edit = (r: Role) =>
      attempt(
        who[r],
        [n.x],
        async (tx) => (await tx`update nodes set title = ${`${tag} x`} where id = ${n.x}`).count,
      );
    const create = (r: Role) =>
      attempt(
        who[r],
        [f.x],
        async (tx) =>
          (
            await tx`insert into nodes (owner_id, type, title, path)
                   values (${L.owner}, 'note', ${`${tag} xnew`}, ${path('x')}::ltree)`
          ).count,
      );
    const moveIn = (r: Role) =>
      attempt(
        who[r],
        [n.x, f.x, f.onDest],
        async (tx) =>
          (await tx`update nodes set path = ${path('ondest')}::ltree where id = ${n.x}`).count,
      );
    const del = (r: Role) =>
      attempt(who[r], [n.x], async (tx) => (await tx`delete from nodes where id = ${n.x}`).count);
    // X's Moderator: its home's, everything here, but adding to a folder of
    // Admin it is not in.
    expect(await edit('modX')).toBe(1);
    expect(await create('modX')).toBe(1);
    expect(await del('modX')).toBe(1);
    expect(await moveIn('modX')).toBe(NO);
    // W's Moderator: create, write, move inside W; no delete.
    expect(await edit('modW')).toBe(1);
    expect(await create('modW')).toBe(1);
    expect(await moveIn('modW')).toBe(1);
    expect(await del('modW')).toBe(NO);
    // An Admin user who is a plain user of W (Admin is not this item's
    // home and does not hold it): it reads the item and the folder through
    // W, so it counts as a Moderator of their home X (owner page d7313c67,
    // decision A): it edits, adds to X's folder, deletes it and moves it
    // anywhere it may add to.
    expect(await edit('admin')).toBe(1);
    expect(await create('admin')).toBe(1);
    expect(await moveIn('admin')).toBe(1);
    expect(await del('admin')).toBe(1);
  });

  it('an Admin user deletes and moves home an item homed in X, which it does not moderate; a holder’s Moderator does not', async () => {
    const del = (r: Role) =>
      attempt(who[r], [n.x], async (tx) => (await tx`delete from nodes where id = ${n.x}`).count);
    const moveHome = (r: Role, to: string) =>
      attempt(who[r], [n.x], async (tx) => {
        await tx`select mantle_grant_move_home(${n.x}::uuid, ${to}::uuid, false, ${who[r].login}::uuid)`;
        const [h] = await tx<{ home: string }[]>`
          select workspace_id::text as home from item_grants where node_id = ${n.x} and is_home`;
        return h?.home === to ? 1 : 0;
      });
    expect(who.admin.mod).not.toContain(ws.X);
    expect(who.admin.mod).toContain(ws.admin);
    expect(await del('admin')).toBe(1);
    // To T (it moderates T) and to Admin.
    expect(await moveHome('admin', ws.T)).toBe(1);
    expect(await moveHome('admin', ws.admin)).toBe(1);
    // A Moderator of W, which holds it (Write on): neither.
    expect(await del('modW')).toBe(NO);
    expect(await moveHome('modW', ws.T)).toBe(NO);
    // The new home still needs a Moderator of it: an Admin user to V, which
    // it is not in, is refused.
    expect(await moveHome('admin', ws.V)).toBe(NO);
  });

  it('decision A: an Admin user edits and manages an item homed in X it reads with Write off; a holder’s Moderator still does not delete', async () => {
    const edit = (r: Role) =>
      attempt(
        who[r],
        [n.xoff],
        async (tx) =>
          (await tx`update nodes set title = ${`${tag} xo`} where id = ${n.xoff}`).count,
      );
    const create = (r: Role) =>
      attempt(
        who[r],
        [f.xoff],
        async (tx) =>
          (
            await tx`insert into nodes (owner_id, type, title, path)
                   values (${L.owner}, 'note', ${`${tag} xonew`}, ${path('xoff')}::ltree)`
          ).count,
      );
    const del = (r: Role) =>
      attempt(
        who[r],
        [n.xoff],
        async (tx) => (await tx`delete from nodes where id = ${n.xoff}`).count,
      );
    const grantRemove = (r: Role) =>
      attempt(who[r], [n.xoff], async (tx) => {
        await tx`select mantle_grant_change('remove', ${n.xoff}::uuid, ${ws.W}::uuid, false, ${who[r].login}::uuid)`;
        return 1;
      });
    expect(who.admin.mod).not.toContain(ws.X);
    expect(who.admin.mod).not.toContain(ws.W);
    // W's grant has Write off and the Admin user is a plain user of W: its
    // rights are the home Moderator's, from the one manage condition.
    expect(await edit('admin')).toBe(1);
    expect(await create('admin')).toBe(1);
    expect(await del('admin')).toBe(1);
    // A Moderator of W (it holds the item): edit and create, no delete.
    expect(await edit('modW')).toBe(1);
    expect(await create('modW')).toBe(1);
    expect(await del('modW')).toBe(NO);
    // A user of W, Write off: neither edit nor delete.
    expect(await edit('userW')).toBe(NO);
    expect(await del('userW')).toBe(NO);
    // A grant's removal: the home's manage; W's Moderators remove their own.
    expect(await grantRemove('admin')).toBe(1);
    expect(await grantRemove('userW')).toBe(NO);
  });

  it('decision A: an Admin user gets nothing on an item it does not read (homed in X, held by X alone)', async () => {
    const p = who.admin;
    expect(p.ws).not.toContain(ws.X);
    // Not found: the row rule hides it, so a write matches no row.
    expect(
      await attempt(
        p,
        [],
        async (tx) => (await tx`select 1 from nodes where id = ${n.xonly}`).count,
      ),
    ).toBe(0);
    expect(
      await attempt(
        p,
        [n.xonly],
        async (tx) =>
          (await tx`update nodes set title = ${`${tag} xn`} where id = ${n.xonly}`).count,
      ),
    ).toBe(0);
    expect(
      await attempt(
        p,
        [n.xonly],
        async (tx) => (await tx`delete from nodes where id = ${n.xonly}`).count,
      ),
    ).toBe(0);
    // No manage through the definers, which find the row whatever the scope
    // reads: a grant's removal, a home move, a new grant.
    expect(
      await attempt(p, [n.xonly], async (tx) => {
        await tx`select mantle_grant_change('remove', ${n.xonly}::uuid, ${ws.X}::uuid, false, ${p.login}::uuid)`;
        return 1;
      }),
    ).toBe(NO);
    expect(
      await attempt(p, [n.xonly], async (tx) => {
        await tx`select mantle_grant_move_home(${n.xonly}::uuid, ${ws.T}::uuid, false, ${p.login}::uuid)`;
        return 1;
      }),
    ).toBe(NO);
    expect(
      await attempt(p, [n.xonly], async (tx) => {
        await tx`select mantle_grant_change('add', ${n.xonly}::uuid, ${ws.T}::uuid, false, ${p.login}::uuid)`;
        return 1;
      }),
    ).toBe(NO);
    // Nor a new item in X's folder.
    expect(
      await attempt(
        p,
        [f.xonly],
        async (tx) =>
          (
            await tx`insert into nodes (owner_id, type, title, path)
                   values (${L.owner}, 'note', ${`${tag} xnnew`}, ${path('xonly')}::ltree)`
          ).count,
      ),
    ).toBe(NO);
    // X's Moderator: everything, as before.
    expect(
      await attempt(
        who.modX,
        [n.xonly],
        async (tx) => (await tx`delete from nodes where id = ${n.xonly}`).count,
      ),
    ).toBe(1);
  });

  it('a folder homed in W keeps today’s rules: a user of W with W’s Write on adds to it', async () => {
    const create = (r: Role) =>
      attempt(
        who[r],
        [f.home],
        async (tx) =>
          (
            await tx`insert into nodes (owner_id, type, title, path)
                   values (${L.owner}, 'note', ${`${tag} hnew`}, ${path('home')}::ltree)`
          ).count,
      );
    expect(await create('userW')).toBe(1);
    expect(await create('modW')).toBe(1);
    expect(await create('outsider')).toBe(NO);
    const del = (r: Role) =>
      attempt(
        who[r],
        [n.home],
        async (tx) => (await tx`delete from nodes where id = ${n.home}`).count,
      );
    expect(await del('modW')).toBe(1);
    expect(await del('userW')).toBe(NO);
  });

  it('the rule functions: edit, add and the move cap, per role', async () => {
    const ask = async (p: Who) => {
      let out: Record<string, boolean> = {};
      await w
        .begin(async (tx) => {
          await tx`select set_config('mantle.ws', ${`{${p.ws.join(',')}}`}, true),
                          set_config('mantle.mod_ws', ${`{${p.mod.join(',')}}`}, true),
                          set_config('mantle.login_id', ${p.login}, true)`;
          const [r] = await tx<Record<string, boolean>[]>`
            select coalesce(mantle_may_edit(n.home_ws, n.write_ws, n.read_ws, n.type), false) as edit,
                   mantle_may_add(f.home_ws, f.write_ws, f.read_ws) as add,
                   coalesce(mantle_may_manage(n.home_ws, n.read_ws), false) as manage,
                   coalesce(mantle_may_manage(n.home_ws, n.read_ws) or mantle_mod_holds(n.read_ws, n.read_ws), false) as move
              from nodes n, nodes f where n.id = ${n.off} and f.id = ${f.off}`;
          out = r ?? {};
          throw new Rollback();
        })
        .catch((err: unknown) => {
          if (!(err instanceof Rollback)) throw err;
        });
      return out;
    };
    expect(await ask(who.admin)).toEqual({ edit: true, add: true, manage: true, move: true });
    // An Admin user on items homed in X it does not moderate: manage and
    // edit of the one it reads (through W), none of the one it does not
    // (asked as a definer would, with the rows read past the row rule).
    const xs = await w.begin(async (tx) => {
      await tx`select set_config('mantle.ws', ${`{${who.admin.ws.join(',')}}`}, true),
                      set_config('mantle.mod_ws', ${`{${who.admin.mod.join(',')}}`}, true),
                      set_config('mantle.login_id', ${who.admin.login}, true)`;
      return tx<{ id: string; manage: boolean; m: boolean; edit: boolean }[]>`
        select x.id, coalesce(mantle_may_manage(x.home, x.rd), false) as manage,
               mantle_may_manage_home(x.home, x.rd) as m,
               coalesce(mantle_may_edit(x.home, '{}'::uuid[], x.rd, 'note'), false) as edit
          from (values (${n.xoff}::text, ${ws.X}::uuid, array[${ws.X}, ${ws.W}]::uuid[]),
                       (${n.xonly}::text, ${ws.X}::uuid, array[${ws.X}]::uuid[])) x(id, home, rd)`;
    });
    expect(new Map(xs.map((r) => [r.id, { manage: r.manage, m: r.m, edit: r.edit }]))).toEqual(
      new Map([
        [n.xoff, { manage: true, m: true, edit: true }],
        [n.xonly, { manage: false, m: false, edit: false }],
      ]),
    );
    expect(await ask(who.modW)).toEqual({ edit: true, add: true, manage: false, move: true });
    expect(await ask(who.userW)).toEqual({ edit: false, add: false, manage: false, move: false });
    // The array form: a preview's (a Moderator of a holder edits).
    const [r] = await sql<{ e: boolean; u: boolean; app: boolean }[]>`
      select mantle_may_edit_in(array[${ws.W}]::uuid[], array[${ws.W}]::uuid[], ${ws.admin}::uuid,
                                '{}'::uuid[], array[${ws.admin}, ${ws.W}]::uuid[], 'note') as e,
             mantle_may_edit_in(array[${ws.W}]::uuid[], '{}'::uuid[], ${ws.admin}::uuid,
                                '{}'::uuid[], array[${ws.admin}, ${ws.W}]::uuid[], 'note') as u,
             mantle_may_edit_in(array[${ws.W}]::uuid[], array[${ws.W}]::uuid[], ${ws.admin}::uuid,
                                '{}'::uuid[], array[${ws.admin}, ${ws.W}]::uuid[], 'app') as app`;
    // An app is not edited by its holders' Moderators: its acts stay its
    // home's Moderators' and its Write grants'.
    expect(r).toEqual({ e: true, u: false, app: false });
    // manage's array form: a Moderator of the home, or of Admin in
    // workspaces that read the item; a Moderator of a holder alone does not
    // manage, nor one of Admin who does not read it.
    const xw = sql`array[${ws.X}, ${ws.W}]::uuid[]`;
    const [m] = await sql<Record<string, boolean>[]>`
      select mantle_may_manage_in(array[${ws.X}]::uuid[], array[${ws.X}]::uuid[], ${ws.X}::uuid, ${xw}) as home,
             mantle_may_manage_in(array[${ws.admin}, ${ws.W}]::uuid[], array[${ws.admin}]::uuid[], ${ws.X}::uuid, ${xw}) as admin,
             mantle_may_manage_in(array[${ws.admin}]::uuid[], array[${ws.admin}]::uuid[], ${ws.X}::uuid, ${xw}) as admin_unread,
             mantle_may_manage_in(array[${ws.W}]::uuid[], array[${ws.W}]::uuid[], ${ws.X}::uuid, ${xw}) as holder,
             mantle_may_manage_in('{}'::uuid[], '{}'::uuid[], ${ws.X}::uuid, ${xw}) as none`;
    expect(m).toEqual({ home: true, admin: true, admin_unread: false, holder: false, none: false });
  });
});
