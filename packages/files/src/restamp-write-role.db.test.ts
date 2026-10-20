/**
 * restampRacedCreate (ops/files.ts) on the write role: run as
 * mantle_write_user in an Admin user's scope, it stamps the row and gives
 * it one home grant in the create's workspace. Its home grant insert names
 * only the four columns of item_grants the role may INSERT; a drizzle
 * insert of the same row names every column (the rest as DEFAULT) and the
 * role is refused (42501), which is why that statement stays raw text
 * (packages/db/src/write-role-inserts.test.ts guards the rest of the code).
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
    await su.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      const [ws] = await tx<{ id: string }[]>`
        insert into workspaces (owner_id, name) values (${owner}, ${`restamp ${randomUUID().slice(0, 6)}`})
        returning id::text as id`;
      other = ws!.id;
      await tx`insert into workspace_users (workspace_id, login_id, moderator)
               values (${other}, ${owner}, true)`;
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
   *  scope (Admin and the other workspace, a Moderator of both), the heads
   *  of `id` held. Commits unless `rollback`. */
  async function asOwnerOnWriteRole<T>(
    id: string,
    fn: (tx: Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0]) => Promise<T>,
    rollback = false,
  ): Promise<{ value?: T; code?: string; who?: string }> {
    let out: { value?: T; code?: string; who?: string } = {};
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
                 set_config('mantle.private_ws', '', true)`)) as unknown as { s: string }[];
        out.who = who!.s;
        await tx.execute(sql`select mantle_lock_heads(array[${id}]::uuid[], 'update')`);
        try {
          out.value = await fn(tx);
        } catch (err) {
          const e = err as { code?: string; cause?: { code?: string } };
          out = { who: out.who, code: e.cause?.code ?? e.code ?? '?' };
          throw new Rollback();
        }
        if (rollback) throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    return out;
  }

  it('stamps the row and homes it in the create workspace, as mantle_write_user', async () => {
    const id = await itemInAdmin();
    const stamp = { snapshot_of: randomUUID(), extract_skipped: { reason: 'snapshot_copy' } };
    const r = await asOwnerOnWriteRole(id, (tx) => restamp(tx as never, id, stamp, other));
    expect(r.code).toBeUndefined();
    expect(r.who).toBe('mantle_write_user');
    expect(r.value?.id).toBe(id);
    const grants = await su<{ ws: string; home: boolean; write: boolean }[]>`
      select workspace_id::text as ws, is_home as home, write from item_grants
       where node_id = ${id} and via_folder_id is null`;
    expect(grants).toEqual([{ ws: other, home: true, write: false }]);
    const [row] = await su<{ data: Record<string, unknown> }[]>`
      select data from nodes where id = ${id}`;
    expect(row!.data.snapshot_of).toBe(stamp.snapshot_of);
    expect((row!.data.extract_skipped as { reason: string; at?: string }).at).toBeTruthy();
  });

  it('a drizzle insert of the same home grant is refused for the role (42501)', async () => {
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
  });
});
