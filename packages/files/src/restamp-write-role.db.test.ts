/**
 * restampRacedCreate (ops/files.ts) on the write role, as
 * mantle_write_user in an Admin user's scope. Its home grant insert names
 * only the four columns of item_grants the role may INSERT, so Postgres
 * takes it past the column rights to the row rule; a drizzle insert of the
 * same row names every column (the rest as DEFAULT) and is refused by the
 * column rights, which is why that statement stays raw text
 * (packages/db/src/write-role-inserts.test.ts guards the rest of the code).
 * The restamp replaces every grant of the row, so with a create home it is
 * system work (snapshot-copies.ts): on the write role the row rule refuses
 * the home of a row the scope no longer reads.
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
  let itemGrants: typeof import('@mantle/db').itemGrants;
  const testKey = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
  let owner = '';
  let admin = '';
  let other = '';

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    const viewer = await import('@mantle/db/viewer');
    ({ itemGrants } = await import('@mantle/db'));
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

  it('its home grant insert passes the role column rights; the row rule refuses the row it no longer reads', async () => {
    // The restamp deletes every grant of the row, then inserts its home: the
    // insert names only columns the role may write, so Postgres takes it to
    // the row rule, which refuses a row the scope no longer reads. So the
    // restamp with a create home is system work only (snapshot-copies.ts).
    const id = await itemInAdmin();
    const stamp = { snapshot_of: randomUUID(), extract_skipped: { reason: 'snapshot_copy' } };
    const r = await asOwnerOnWriteRole(id, (tx) => restamp(tx as never, id, stamp, other), true);
    expect(r.who).toBe('mantle_write_user');
    expect(r.code).toBe('42501');
    expect(r.message).toMatch(/row-level security policy for table "item_grants"/);
    expect(r.message).not.toMatch(/permission denied/);
  });

  it('a drizzle insert of the same home grant is refused by the role column rights', async () => {
    const id = await itemInAdmin();
    const r = await asOwnerOnWriteRole(
      id,
      async (tx) => {
        await tx.delete(itemGrants).where(sql`${itemGrants.nodeId} = ${id}`);
        await tx
          .insert(itemGrants)
          .values({ nodeId: id, workspaceId: other, isHome: true, write: false });
      },
      true,
    );
    expect(r.who).toBe('mantle_write_user');
    expect(r.code).toBe('42501');
    expect(r.message).toMatch(/permission denied for table item_grants/);
  });
});
