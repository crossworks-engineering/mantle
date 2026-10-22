/**
 * The would-refuse count (migration 0319),
 * report only, on a real, migrated Postgres: with the switch off a narrow
 * reason's writes run on the full route, and each one the narrow role
 * would refuse once the switch is on is counted (a NOTICE the app's pool
 * turns into a miss row, check narrow-would-refuse), the write itself
 * unchanged:
 *
 *  - a table privilege the role does not hold (an INSERT or DELETE), and
 *    an UPDATE that names a column it may not update, through the
 *    statement-level triggers migrate derives from its live grants
 *    (runtime-role.ts applyNarrowWouldRefuse): a write it may make fires
 *    nothing, a content table has none (0312 counts those);
 *  - 0318's one-way rules (mantle_narrow_one_way's report branch): the row
 *    is written, and counted;
 *  - never at a spot, by another actor, or on the narrow role itself
 *    (refused there, as before).
 *
 * The runtime role's login (current_user = session_user), as on every
 * fleet box.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/narrow-would-refuse.db.test.ts
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';
import {
  NARROW_ROLE,
  NARROW_WOULD_REFUSE_TRIGGERS,
  ensureRuntimeRoles,
  runtimeDatabaseUrl,
  runtimeRolePassword,
} from './runtime-role';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const KEY = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
const PREFIX = 'mantle narrow write: ';

const actorSql = (actor: string, spot = false) =>
  `select set_config('mantle.actor', '${actor}', true), set_config('mantle.write_mode', 'rw', true)` +
  (spot ? `, set_config('mantle.route', 'full', true)` : '');

describe.skipIf(!URL)('the would-refuse count (plan v3.2 S7b part b2 round 9)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let rt: ReturnType<typeof postgres>;
  let anchor = '';
  const notices: string[] = [];
  const counted = () => notices.splice(0).filter((n) => n.startsWith(PREFIX));

  /** Statements in one transaction on `conn`, rolled back: the first
   *  error's code, or null. */
  const inTx = async (conn: ReturnType<typeof postgres>, stmts: string[]) => {
    try {
      await conn.begin(async (tx) => {
        for (const st of stmts) await tx.unsafe(st);
        throw Object.assign(new Error('rollback'), { rollback: true });
      });
    } catch (err) {
      if ((err as { rollback?: boolean }).rollback) return null;
      return (err as { code?: string }).code ?? 'error';
    }
    return null;
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    const keep = (n: { message?: string }) => notices.push(n.message ?? '');
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: keep });
    expect(await ensureRuntimeRoles(su, KEY, { login: true, narrowLogin: true })).toBe('ok');
    anchor = await ensureTestAnchor(su);
    rt = postgres(runtimeDatabaseUrl(scratch.url, runtimeRolePassword(KEY)), {
      max: 1,
      prepare: false,
      onnotice: keep,
    });
  }, 180_000);

  afterAll(async () => {
    await rt?.end();
    await su?.end();
    await scratch?.drop();
  }, 60_000);

  it('the triggers follow the narrow role`s grants: none for a write it may make, none on a content table', async () => {
    const rows = await su<{ t: string; name: string; cols: string[] }[]>`
      select g.tgrelid::regclass::text as t, g.tgname::text as name,
             array(select a.attname::text from unnest(g.tgattr::int2[]) k(n)
                     join pg_attribute a on a.attrelid = g.tgrelid and a.attnum = k.n) as cols
        from pg_trigger g
       where g.tgname = any(${Object.values(NARROW_WOULD_REFUSE_TRIGGERS)}::text[])
         and not g.tgisinternal`;
    const on = (t: string, name: string) => rows.find((r) => r.t === t && r.name === name);
    // audit_log: INSERT only, so a delete and every column's update count.
    expect(on('audit_log', NARROW_WOULD_REFUSE_TRIGGERS.INSERT)).toBeUndefined();
    expect(on('audit_log', NARROW_WOULD_REFUSE_TRIGGERS.DELETE)).toBeDefined();
    // agents: no insert, no delete; its destination and grant columns
    // counted, its measured columns not.
    expect(on('agents', NARROW_WOULD_REFUSE_TRIGGERS.INSERT)).toBeDefined();
    const agentCols = on('agents', NARROW_WOULD_REFUSE_TRIGGERS.UPDATE)!.cols;
    expect(agentCols).toEqual(expect.arrayContaining(['api_key_id', 'configured_by', 'role']));
    expect(agentCols).not.toContain('name');
    // A content table: 0312's count, none of these.
    expect(rows.filter((r) => r.t === 'nodes')).toEqual([]);
    // Every UPDATE OF list is exactly the columns the role may not update.
    for (const r of rows.filter((x) => x.name === NARROW_WOULD_REFUSE_TRIGGERS.UPDATE)) {
      const [g] = await su<{ held: string[] }[]>`
        select array(select a.attname::text from pg_attribute a
                      where a.attrelid = ${r.t}::regclass and a.attnum > 0 and not a.attisdropped
                        and has_column_privilege(${NARROW_ROLE}, a.attrelid, a.attnum, 'UPDATE')) as held`;
      expect(
        r.cols.filter((c) => g!.held.includes(c)),
        r.t,
      ).toEqual([]);
    }
  });

  it('counts a narrow reason`s write the role would refuse, once per table and operation; the write runs', async () => {
    counted();
    const who = 'system:http:admin-area';
    expect(
      await inTx(rt, [
        actorSql(who),
        'delete from public.audit_log where false',
        'delete from public.audit_log where false',
        'update public.agents set api_key_id = api_key_id where false',
        // An upsert's SET needs UPDATE on what it names, a conflict or not.
        `insert into public.provider_alerts (owner_id, subject, code, permanent, reason)
           values ('${anchor}', 'embedding', 'x', false, 'x')
           on conflict (owner_id, subject) do update set owner_id = excluded.owner_id`,
      ]),
    ).toBeNull();
    expect(counted().sort()).toEqual(
      [
        `${PREFIX}narrow-would-refuse ${who} public.audit_log DELETE`,
        `${PREFIX}narrow-would-refuse ${who} public.agents UPDATE`,
        `${PREFIX}narrow-would-refuse ${who} public.provider_alerts UPDATE`,
      ].sort(),
    );
  });

  it('counts nothing for a write the role may make, at a spot, or by another actor', async () => {
    counted();
    const allowed = [
      'update public.traces set status = status where false',
      `insert into public.audit_log (actor_email, action) values ('t@t', 't')`,
      'update public.agents set name = name where false',
    ];
    expect(await inTx(rt, [actorSql('system:admin-area'), ...allowed])).toBeNull();
    const refused = ['delete from public.audit_log where false'];
    expect(await inTx(rt, [actorSql('system:admin-area', true), ...refused])).toBeNull();
    expect(await inTx(rt, [actorSql(`login:rw:${anchor}`), ...refused])).toBeNull();
    expect(await inTx(rt, [actorSql('system:brain-bookkeeping'), ...refused])).toBeNull();
    expect(counted()).toEqual([]);
  });

  it("0318's one-way rules: counted off the narrow route and the row written; refused on the narrow role", async () => {
    counted();
    const who = 'system:http:admin-area';
    const lower = `update auth.users set session_epoch = session_epoch - 1 where id = '${anchor}'`;
    const moved = await rt
      .begin(async (tx) => {
        await tx.unsafe(actorSql(who));
        const [b] = await tx<
          { e: number }[]
        >`select session_epoch as e from auth.users where id = ${anchor}`;
        await tx.unsafe(lower);
        const [a] = await tx<
          { e: number }[]
        >`select session_epoch as e from auth.users where id = ${anchor}`;
        throw Object.assign(new Error('rollback'), { moved: b!.e - a!.e });
      })
      .catch((e: { moved?: number }) => e.moved);
    expect(moved).toBe(1);
    expect(counted()).toEqual([`${PREFIX}narrow-would-refuse ${who} auth.users UPDATE`]);
    // At a spot: written, not counted.
    expect(await inTx(rt, [actorSql(who, true), lower])).toBeNull();
    expect(counted()).toEqual([]);
    // On the narrow role: refused, as 0318 had it (no count: the role's own
    // refusal is narrow-denied).
    expect(await inTx(su, [actorSql(who), `set local role ${NARROW_ROLE}`, lower])).toBe('42501');
    expect(counted()).toEqual([]);
  });
});
