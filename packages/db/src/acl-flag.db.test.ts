/**
 * The derivation's flag on item_grants (migration 0326 part 4, plan v3.2
 * S7b part b2): mantle.acl_internal is a session setting, and the
 * item_grants triggers read it alone (the heads check and the folder
 * propagation are skipped while it is on). Before 0326 a write role
 * session (an Admin scope) or the runtime role that set it itself
 * unshared a folder and the folder's item stayed readable in that
 * workspace. Now the functions that set it sign it (mantle_acl_on), the
 * triggers ask mantle_acl_signed(), and a session's own flag is the flag
 * off.
 *
 * 1. A forged flag ('on', or 'on' with a mark from another transaction) on
 *    the write role and the runtime role, by a direct write and through
 *    the grant definer: the heads check runs (40001 with it on) and the
 *    propagation runs (the item follows its folder).
 * 2. The derivation's own signed flag still skips both (a positive
 *    control: the cells above would see a skip).
 * 3. No app role may run the four helpers.
 * 4. The catalog check reads no leak, and finds each planted form.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityLeaks } from './identity-gateway';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const ROLES = ['mantle_write_user', 'mantle_runtime'] as const;
const HELPERS = [
  'public.mantle_acl_on()',
  'public.mantle_acl_saved()',
  'public.mantle_acl_restore(text)',
  'public.mantle_acl_signed()',
];

type Flag = 'none' | 'on' | 'stale';
type Op = 'delete' | 'definer' | 'insert';
type Got = { code: string; child: string[] };

describe.skipIf(!URL)('0326: the derivation flag is signed (item_grants)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let owner = '';
  let admin = '';
  const ws = randomUUID();
  const ws3 = randomUUID();
  const folder = randomUUID();
  const child = randomUUID();
  let stale = '';

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    owner = await ensureTestAnchor(su);
    const [a] = await su`select id::text as id from workspaces where is_admin limit 1`;
    admin =
      a?.id ??
      (
        await su`insert into workspaces (owner_id, name, is_admin, bridge_key)
                  values (${owner}, 'Admin', true, 'admin') returning id::text as id`
      )[0]!.id;
    await su`insert into workspace_users (workspace_id, login_id, moderator)
              values (${admin}, ${owner}, true) on conflict do nothing`;
    await su`insert into workspaces (id, owner_id, name) values (${ws}, ${owner}, 'Acl ws'), (${ws3}, ${owner}, 'Acl ws 3')`;
    await su`insert into nodes (id, owner_id, type, title, path) values
              (${folder}, ${owner}, 'branch', 'Acl folder', 'aclflag.f1'),
              (${child}, ${owner}, 'note', 'Acl item', 'aclflag.f1')`;
    // The folder shared the right way: the item follows it.
    await su`insert into item_grants (node_id, workspace_id, write) values (${folder}, ${ws}, false)`;
    const [m] = await su.begin(async (t) => {
      await t`select mantle_acl_on()`;
      return t<{ mark: string }[]>`select current_setting('mantle.acl_sig') as mark`;
    });
    stale = m!.mark;
  }, 180_000);

  afterAll(async () => {
    await su?.end();
    await scratch?.drop();
  });

  const childRows = async (t: postgres.TransactionSql) =>
    (
      await t<{ w: string }[]>`
        select workspace_id::text as w from item_grants where node_id = ${child} order by 1`
    ).map((r) => r.w);

  /** One write as `role` with an Admin scope over the three workspaces,
   *  rolled back: its error code ('ok' when none) and the item's grant
   *  rows after it. */
  const cell = (role: string, flag: Flag, op: Op, heads: 'on' | 'warn') =>
    su
      .begin(async (t) => {
        const scope = `{${admin},${ws},${ws3}}`;
        await t`select set_config('mantle.login_id', ${owner}, true),
                       set_config('mantle.scope_login', ${owner}, true),
                       set_config('mantle.ws', ${scope}, true),
                       set_config('mantle.mod_ws', ${scope}, true),
                       set_config('mantle.heads_check', ${heads}, true),
                       set_config('mantle.acl_internal', ${flag === 'none' ? '' : 'on'}, true),
                       set_config('mantle.acl_sig', ${flag === 'stale' ? stale : ''}, true)`;
        await t.unsafe(`set local role ${role}`);
        const code = await t
          .savepoint(async (s) => {
            if (op === 'delete') {
              await s`delete from item_grants where node_id = ${folder} and workspace_id = ${ws}`;
            } else if (op === 'definer') {
              await s`select mantle_grant_change('remove', ${folder}::uuid, ${ws}::uuid, false, ${owner}::uuid)`;
            } else {
              await s`insert into item_grants (node_id, workspace_id, write) values (${folder}, ${ws3}, false)`;
            }
          })
          .then(
            () => 'ok',
            (e: { code?: string }) => e.code ?? 'error',
          );
        await t.unsafe('reset role');
        const got: Got = { code, child: await childRows(t) };
        throw Object.assign(new Error('rollback'), { got });
      })
      .catch((e: { got?: Got }) => {
        if (!e.got) throw e;
        return e.got;
      });

  it('the item follows its folder before any cell', async () => {
    const rows = await su<{ w: string }[]>`
      select workspace_id::text as w from item_grants where node_id = ${child}`;
    expect(rows.map((r) => r.w)).toContain(ws);
  });

  for (const role of ROLES) {
    for (const flag of ['none', 'on', 'stale'] as const) {
      it(`${role}, flag ${flag}: the unshare reaches the item, directly and through the definer`, async () => {
        for (const op of ['delete', 'definer'] as const) {
          const got = await cell(role, flag, op, 'warn');
          expect(got.code, op).toBe('ok');
          expect(got.child, op).not.toContain(ws);
        }
        const added = await cell(role, flag, 'insert', 'warn');
        expect(added.code).toBe('ok');
        expect(added.child).toContain(ws3);
      });

      it(`${role}, flag ${flag}: the heads check runs (refused with it on)`, async () => {
        for (const op of ['delete', 'definer', 'insert'] as const) {
          expect((await cell(role, flag, op, 'on')).code, op).toBe('40001');
        }
      });
    }
  }

  it("the derivation's own signed flag still skips the propagation (the control)", async () => {
    const got = await su
      .begin(async (t) => {
        await t`select mantle_acl_on()`;
        await t`delete from item_grants where node_id = ${folder} and workspace_id = ${ws}`;
        const signed = await t<{ ok: boolean }[]>`select mantle_acl_signed() as ok`;
        await t`select mantle_acl_restore('')`;
        const after = await t<{ ok: boolean }[]>`select mantle_acl_signed() as ok`;
        throw Object.assign(new Error('rollback'), {
          got: { signed: signed[0]!.ok, after: after[0]!.ok, child: await childRows(t) },
        });
      })
      .catch((e: { got?: { signed: boolean; after: boolean; child: string[] } }) => {
        if (!e.got) throw e;
        return e.got;
      });
    expect(got).toEqual({ signed: true, after: false, child: expect.arrayContaining([ws]) });
  });

  it('no app role may run the helpers', async () => {
    const rows = await su<{ role: string; fn: string; ok: boolean }[]>`
      select r.rolname as role, f as fn, has_function_privilege(r.oid, f::regprocedure, 'EXECUTE') as ok
        from pg_roles r, unnest(${HELPERS}::text[]) f
       where r.rolname like 'mantle\\_%' and r.rolname <> 'mantle_owner'`;
    expect(rows.length).toBeGreaterThan(HELPERS.length * 3);
    expect(rows.filter((r) => r.ok)).toEqual([]);
  });

  it('the catalog check reads no leak', async () => {
    expect(await identityLeaks(su)).toEqual([]);
  });

  it('the catalog check finds every planted form', async () => {
    const found = await su
      .begin(async (t) => {
        await t.unsafe(`create function public.acl_leak_a() returns void language plpgsql as
          $$ begin perform set_config('mantle.acl_internal', 'on', true); end $$`);
        await t.unsafe(`create function public.acl_leak_b() returns boolean language sql stable as
          $$ select public.mantle_acl_internal() $$`);
        await t.unsafe(`create function public.acl_leak_c() returns text language sql stable as
          $$ select current_setting('mantle.acl_sig', true) $$`);
        await t.unsafe(`create trigger acl_leak_t before update on public.agents for each row
          when (current_setting('mantle.acl_internal', true) = 'on') execute function touch_updated_at()`);
        const rows = await identityLeaks(t as unknown as postgres.Sql);
        throw Object.assign(new Error('rollback'), { rows });
      })
      .catch((e: { rows?: { object: string; detail: string }[] }) => {
        if (!e.rows) throw e;
        return e.rows;
      });
    const line = (o: string) => found.filter((r) => r.object.includes(o)).map((r) => r.detail);
    expect(line('acl_leak_a()')).toEqual([
      expect.stringMatching(/sets the derivation flag itself/),
    ]);
    expect(line('acl_leak_b()')).toEqual([
      expect.stringMatching(/decides from the derivation flag alone/),
    ]);
    expect(line('acl_leak_c()')).toEqual([
      expect.stringMatching(/reads the derivation flag itself/),
    ]);
    expect(line('acl_leak_t')).toEqual([expect.stringMatching(/reads the derivation flag/)]);
    expect(found).toHaveLength(4);
  });
});
