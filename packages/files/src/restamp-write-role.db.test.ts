/**
 * restampRacedCreate (ops/files.ts): the stamp of a snapshot copy whose
 * create lost its name to the files watcher, and its home, by the home's
 * definer (mantle_file_restamp_home, 0313).
 *
 *  - On the write role, as mantle_write_user in an Admin user's scope: the
 *    stamp alone (a typed update) passes; with a create home the role may
 *    not run the definer (no EXECUTE), so a scope never replaces a row's
 *    grants this way.
 *  - The definer's own check: only the snapshot copies' system work (no
 *    acting login, no scope, not read only, the actor
 *    system:snapshot-copies), only on a file of this brain that carries a
 *    copy's stamp. Each other caller is refused (42501) and nothing moves.
 *  - As that system work it replaces every grant of the row with one home,
 *    Write off: the four columns the raw insert named, the rest their
 *    defaults; and through @mantle/db's systemWork, in every check mode
 *    (the actor goes with the statement with the check off too).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/files/src/restamp-write-role.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Rolls a cell's transaction back after its checks. */
class Rollback extends Error {}

describe.skipIf(!URL)('restampRacedCreate on the write role', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let ts: Ts;
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let su: ReturnType<Ts['superuserClient']>;
  let w: ReturnType<Ts['superuserClient']>;
  let restamp: typeof import('./ops/files').restampRacedCreate;
  const testKey = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
  let owner = '';
  let admin = '';
  let other = '';

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    const viewer = await import('@mantle/db/viewer');
    ({ restampRacedCreate: restamp } = await import('./ops/files'));
    scratch = await ts.createMigratedScratchDatabase(URL!);
    su = ts.superuserClient(scratch.url, 2);
    // A client of its own on the write role's login (session_user is
    // mantle_write_user, as the app's write pool logs in).
    w = ts.superuserClient(
      viewer.viewerDatabaseUrl(scratch.url, 'write', viewer.viewerRolePassword(testKey, 'write')),
    );
    admin = await ts.ensureAdminUsers(su, []);
    owner = await ts.ensureTestAnchor(su);
    // The create workspace: the owner's private one, as a snapshot copy's
    // home is (the database lets a copy be homed there, Write off, and
    // nowhere wider).
    // Made by hand as the superuser (the fixture, not a definer under test).
    await su.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      const [ws] = await tx<{ id: string }[]>`
        insert into workspaces (owner_id, name, description, created_by)
        values (${owner}, 'Owner (only you)', 'Your own work. Only you see it.', ${owner})
        returning id::text as id`;
      other = ws!.id;
      await tx`insert into workspace_users (workspace_id, login_id, moderator)
               values (${other}, ${owner}, true)`;
      await tx`insert into private_workspaces (login_id, workspace_id) values (${owner}, ${other})
               on conflict (login_id) do update set workspace_id = excluded.workspace_id`;
    });
  }, 240_000);

  afterAll(async () => {
    await w?.end();
    await su?.end();
    await scratch?.drop();
  });

  /** A note homed in the Admin workspace, made as the superuser. */
  async function itemInAdmin(): Promise<string> {
    const id = randomUUID();
    await su.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into nodes (id, owner_id, type, title, path, data)
               values (${id}, ${owner}, 'note', 'raced', 'notes'::ltree, '{}'::jsonb)`;
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id}`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${id}, ${admin}, true, false)`;
    });
    return id;
  }

  /** Run `fn` in a drizzle transaction on the write role in the owner's
   *  scope (Admin and its private workspace, a Moderator of both), the heads
   *  of `id` held. Commits unless `rollback`. */
  async function asOwnerOnWriteRole<T>(
    id: string,
    fn: (tx: Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0]) => Promise<T>,
    rollback = false,
  ): Promise<{ value?: T; code?: string; message?: string; who?: string }> {
    let out: { value?: T; code?: string; message?: string; who?: string } = {};
    try {
      await drizzle(w).transaction(async (tx) => {
        const [who] = (await tx.execute(sql`
          select session_user::text as s,
                 set_config('mantle.actor', ${`login:owner:${owner}`}, true),
                 set_config('mantle.write_mode', 'rw', true),
                 set_config('mantle.actor_check', 'on', true),
                 set_config('mantle.ws', ${`{${admin},${other}}`}, true),
                 set_config('mantle.mod_ws', ${`{${admin},${other}}`}, true),
                 set_config('mantle.login_id', ${owner}, true),
                 set_config('mantle.create_ws', ${other}, true),
                 set_config('mantle.private_ws', ${other}, true)`)) as unknown as { s: string }[];
        out.who = who!.s;
        await tx.execute(sql`select mantle_lock_heads(array[${id}]::uuid[], 'update')`);
        try {
          out.value = await fn(tx);
        } catch (err) {
          const e = err as {
            code?: string;
            message?: string;
            cause?: { code?: string; message?: string };
          };
          out = {
            who: out.who,
            code: e.cause?.code ?? e.code ?? '?',
            message: e.cause?.message ?? e.message,
          };
          throw new Rollback();
        }
        if (rollback) throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    return out;
  }

  it('stamps the row on the write role (no create home)', async () => {
    const id = await itemInAdmin();
    const stamp = { snapshot_of: randomUUID(), extract_skipped: { reason: 'snapshot_copy' } };
    const r = await asOwnerOnWriteRole(id, (tx) => restamp(tx as never, id, stamp, null));
    expect(r.code, r.message).toBeUndefined();
    expect(r.who).toBe('mantle_write_user');
    expect(r.value?.id).toBe(id);
    const [row] = await su<{ data: Record<string, unknown> }[]>`
      select data from nodes where id = ${id}`;
    expect(row!.data.snapshot_of).toBe(stamp.snapshot_of);
    expect((row!.data.extract_skipped as { at?: string }).at).toBeTruthy();
    const grants = await su<{ ws: string; home: boolean }[]>`
      select workspace_id::text as ws, is_home as home from item_grants where node_id = ${id}`;
    expect(grants).toEqual([{ ws: admin, home: true }]);
  });

  it('with a create home the write role may not run the home definer', async () => {
    const id = await itemInAdmin();
    const stamp = { snapshot_of: randomUUID(), extract_skipped: { reason: 'snapshot_copy' } };
    const r = await asOwnerOnWriteRole(id, (tx) => restamp(tx as never, id, stamp, other), true);
    expect(r.who).toBe('mantle_write_user');
    expect(r.code).toBe('42501');
    expect(r.message).toMatch(/permission denied for function mantle_file_restamp_home/);
    expect(await grantsOf(id)).toEqual([{ ws: admin, home: true, write: false, by: null }]);
  });

  /** A file of the brain, homed in Admin (Write off), and `more` grants,
   *  then stamped as a copy when `stamped` (the database refuses a wider
   *  grant on a row that already carries the stamp). */
  async function fileInAdmin(
    stamped: boolean,
    type: 'file' | 'note' = 'file',
    more: { ws: string; by: string }[] = [],
  ): Promise<string> {
    const id = randomUUID();
    await su.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into nodes (id, owner_id, type, title, path, data)
               values (${id}, ${owner}, ${type}, 'raced', ${type === 'file' ? 'files' : 'notes'}::ltree,
                       '{}'::jsonb)`;
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id}`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${id}, ${admin}, true, false)`;
      for (const g of more) {
        await tx`insert into item_grants (node_id, workspace_id, is_home, write, granted_by)
                 values (${id}, ${g.ws}, false, true, ${g.by})`;
      }
      if (stamped) {
        await tx`update nodes set data = jsonb_build_object('snapshot_of', ${randomUUID()}::text)
                  where id = ${id}`;
      }
    });
    return id;
  }

  async function grantsOf(
    id: string,
  ): Promise<{ ws: string; home: boolean; write: boolean; by: string | null }[]> {
    return su<{ ws: string; home: boolean; write: boolean; by: string | null }[]>`
      select workspace_id::text as ws, is_home as home, write, granted_by::text as by
        from item_grants where node_id = ${id} order by workspace_id`;
  }

  /** The definer as the superuser (it may run it) with these settings. */
  async function homeAs(
    id: string,
    settings: Record<string, string>,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    try {
      await su.begin(async (tx) => {
        for (const [k, v] of Object.entries(settings)) {
          await tx`select set_config(${k}, ${v}, true)`;
        }
        await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
        await tx`select "public"."mantle_file_restamp_home"(${id}::uuid, ${other}::uuid)`;
      });
      return { ok: true };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { ok: false, code: e.code ?? '?', message: e.message ?? '' };
    }
  }

  const SYSTEM_WORK = { 'mantle.actor': 'system:snapshot-copies', 'mantle.write_mode': 'rw' };

  it("the definer takes the snapshot copies' system work only, and leaves the row as it was otherwise", async () => {
    const id = await fileInAdmin(true);
    const refusals: Record<string, string>[] = [
      {},
      { 'mantle.actor': 'system:test', 'mantle.write_mode': 'rw' },
      { 'mantle.actor': 'system:ws-clear-ticks', 'mantle.write_mode': 'rw' },
      { 'mantle.actor': 'system:boot:migrate-workspaces', 'mantle.write_mode': 'rw' },
      { 'mantle.actor': 'system:admin-area', 'mantle.write_mode': 'rw' },
      { 'mantle.actor': 'system:operator:repair', 'mantle.write_mode': 'rw' },
      { 'mantle.actor': `login:rw:${owner}`, 'mantle.write_mode': 'rw' },
      // The right actor, but read only, in a scope, or with a login set.
      { ...SYSTEM_WORK, 'mantle.write_mode': 'ro' },
      { ...SYSTEM_WORK, 'mantle.ws': `{${admin}}` },
      { ...SYSTEM_WORK, 'mantle.scope_login': owner },
    ];
    for (const settings of refusals) {
      const r = await homeAs(id, settings);
      expect(r, JSON.stringify(settings)).toMatchObject({ ok: false, code: '42501' });
      expect((r as { message: string }).message).toMatch(/system work only/);
    }
    expect(await grantsOf(id)).toEqual([{ ws: admin, home: true, write: false, by: null }]);
    // The right caller on a row that is no stamped copy file of this brain.
    for (const row of [await fileInAdmin(false), await fileInAdmin(true, 'note')]) {
      const r = await homeAs(row, SYSTEM_WORK);
      expect(r).toMatchObject({ ok: false, code: '42501' });
      expect((r as { message: string }).message).toMatch(/not a stamped copy/);
      expect(await grantsOf(row)).toEqual([{ ws: admin, home: true, write: false, by: null }]);
    }
  });

  it("as the snapshot copies' system work it replaces every grant with one home, Write off", async () => {
    // A second grant, made by a login: it goes too.
    const id = await fileInAdmin(true, 'file', [{ ws: other, by: owner }]);
    expect(await grantsOf(id)).toHaveLength(2);
    expect(await homeAs(id, SYSTEM_WORK)).toEqual({ ok: true });
    expect(await grantsOf(id)).toEqual([{ ws: other, home: true, write: false, by: null }]);
    const [g] = await su<{ via: string | null; bridge: boolean | null }[]>`
      select via_folder_id::text as via, bridge from item_grants where node_id = ${id}`;
    expect(g).toEqual({ via: null, bridge: false });
  });

  it("restampRacedCreate under @mantle/db's systemWork('snapshot-copies'): stamped and homed", async () => {
    // The app's own pools on this scratch database (the system pool as the
    // box runs it: the superuser, or mantle_runtime under test:runtime-role).
    process.env.DATABASE_URL = scratch!.url;
    process.env.MANTLE_MASTER_KEY ??= testKey;
    const m = await import('@mantle/db');
    try {
      const id = await fileInAdmin(false);
      const stamp = { snapshot_of: randomUUID(), extract_skipped: { reason: 'snapshot_copy' } };
      const seen = await m.systemWork(
        () =>
          m.db.transaction(async (tx) => {
            await tx.execute(sql`select mantle_lock_heads(array[${id}]::uuid[], 'update')`);
            const row = await restamp(tx as never, id, stamp, other);
            const [a] = (await tx.execute(
              sql`select current_setting('mantle.actor', true) as a`,
            )) as unknown as { a: string }[];
            return { row, actor: a!.a };
          }),
        'snapshot-copies',
      );
      expect(seen.actor).toBe('system:snapshot-copies');
      expect(seen.row.id).toBe(id);
      expect((seen.row.data as Record<string, unknown>).snapshot_of).toBe(stamp.snapshot_of);
      expect(await grantsOf(id)).toEqual([{ ws: other, home: true, write: false, by: null }]);
    } finally {
      await m.closeDb();
    }
  });
});
