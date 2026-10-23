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
 *    (refused there, as before);
 *  - the app's own path (round 10, the counter's blind spot closed): a
 *    systemDb write inside a login's turn scope with the switch off, whose
 *    actor is the login's, is counted by the narrow route's mark
 *    (mantle.route = 'narrow', gateway/pools.ts getScopeMarkedDb) when the
 *    role would refuse it, with the actor check off and in warn; an
 *    allowed write (the product's own provider_alerts upsert) is not; the
 *    same write outside a scope or at a spot is not.
 *
 * The runtime role's login (current_user = session_user), as on every
 * fleet box.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/narrow-would-refuse.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';
import { applyJournal } from './migrate-runner';
import {
  NARROW_ROLE,
  NARROW_WOULD_REFUSE_TRIGGERS,
  applyNarrowWouldRefuse,
  dropNarrowWouldRefuse,
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
    // Two rules broken, two notes of the one row (the box count reads them
    // distinct): 0318's up:session_epoch, and 0326's hold (the owner's).
    expect(counted()).toEqual([
      `${PREFIX}narrow-would-refuse ${who} auth.users UPDATE`,
      `${PREFIX}narrow-would-refuse ${who} auth.users UPDATE`,
    ]);
    // At a spot: written, not counted.
    expect(await inTx(rt, [actorSql(who, true), lower])).toBeNull();
    expect(counted()).toEqual([]);
    // On the narrow role: refused, as 0318 had it (no count: the role's own
    // refusal is narrow-denied).
    expect(await inTx(su, [actorSql(who), `set local role ${NARROW_ROLE}`, lower])).toBe('42501');
    expect(counted()).toEqual([]);
  });

  it("the app's path: systemDb in a login's turn scope, the switch off, is counted by the route mark when the role would refuse it", async () => {
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= KEY;
    const m = await import('./index');
    const v = await import('./viewer');
    const rr = await import('./runtime-role');
    const actor = await import('./actor');
    const alerts = await import('./provider-alerts');
    const pa = m.providerAlerts;
    const scope = {
      kind: 'assistant' as const,
      loginId: anchor,
      ws: [randomUUID()],
      modWs: [] as string[],
    };
    /** provider_alerts' upsert, its SET naming the owner (the narrow role
     *  updates 15 of its columns, never owner_id): the class round 8's
     *  allowlist missed. Rolled back after (only the count is read). */
    const refusedUpsert = () =>
      m.systemDb
        .transaction(async (tx) => {
          await tx
            .insert(pa)
            .values({
              ownerId: anchor,
              subject: 'extraction',
              code: 'x',
              permanent: false,
              reason: 'x',
            })
            .onConflictDoUpdate({
              target: [pa.ownerId, pa.subject],
              set: { ownerId: sql`excluded.owner_id` },
            });
          await tx.execute(sql`delete from public.audit_log where false`);
          throw Object.assign(new Error('rollback'), { rollback: true });
        })
        .catch((e: { rollback?: boolean }) => {
          if (!e.rollback) throw e;
        });
    const pick = () =>
      actor
        .takeNarrowWrites()
        .filter((w) => w.check === 'narrow-would-refuse')
        .map((w) => `${w.actor.split(':')[0]} ${w.detail}`)
        .sort();
    try {
      for (const mode of ['off', 'warn'] as const) {
        await m.closeDb();
        await su`select mantle_set_actor_check(${mode}, 50, 'test')`;
        rr.setNarrowSystemForTests(false);
        actor.takeNarrowWrites();
        // The product's own upsert (every column it names granted): nothing.
        await m.withTurnScope(scope, async () => {
          await alerts.recordProviderFailure(anchor, 'embedding', {
            code: 'c',
            permanent: false,
            reason: 'r',
          });
        });
        expect(pick(), mode).toEqual([]);
        // A write the role would refuse: counted, the login's actor, while
        // the actor check is warn or on (the process's or the box's, the
        // higher): only then is the actor, and so the mark, sent. With both
        // off (the box off in test:actor-off) nothing is sent or counted.
        const counts = actor.actorCheckMode() !== 'off';
        if (mode === 'warn') expect(counts).toBe(true);
        await m.withTurnScope(scope, refusedUpsert);
        expect(pick(), mode).toEqual(
          counts
            ? ['login public.audit_log DELETE', 'login public.provider_alerts UPDATE'].sort()
            : [],
        );
        // The same at a spot inside the scope, or outside every scope with
        // the login's actor: not counted (no mark).
        await m.withTurnScope(scope, () => v.onFullSystemRoute('profile-row', refusedUpsert));
        await m.runAsActor(m.loginActor(anchor, 'rw'), refusedUpsert);
        expect(pick(), mode).toEqual([]);
      }
    } finally {
      await m.closeDb();
      rr.setNarrowSystemForTests(null);
      await su`delete from public.provider_alerts where owner_id = ${anchor}`;
    }
  });

  it('a migration that drops or retypes a watched column applies over a migrated database; the triggers come back after it', async () => {
    const upd = NARROW_WOULD_REFUSE_TRIGGERS.UPDATE;
    const watched = async (col: string) => {
      const [r] = await su<{ n: number }[]>`
        select count(*)::int as n from pg_trigger g
          join pg_attribute a on a.attrelid = g.tgrelid and a.attnum = any(g.tgattr::int2[])
         where g.tgrelid = 'public.agents'::regclass and g.tgname = ${upd} and a.attname = ${col}`;
      return r!.n;
    };
    const onAgents = async () =>
      (
        await su<{ name: string }[]>`
          select tgname::text as name from pg_trigger
           where tgrelid = 'public.agents'::regclass and not tgisinternal
             and tgname = any(${Object.values(NARROW_WOULD_REFUSE_TRIGGERS)}::text[]) order by 1`
      ).map((r) => r.name);
    // Two columns the narrow role may not update, so the UPDATE OF trigger
    // watches them, as a migrated box's watches its real ones.
    await su.unsafe(
      `alter table public.agents add column zz_drop_probe text, add column zz_type_probe text`,
    );
    await applyNarrowWouldRefuse(su);
    expect(await watched('zz_drop_probe')).toBe(1);
    expect(await watched('zz_type_probe')).toBe(1);
    const before = await onAgents();
    expect(before).toContain(upd);
    // What a later migration meets with the triggers left in place: 2BP01
    // for the drop, 0A000 for the retype (the column is in a trigger).
    expect(await inTx(su, ['alter table public.agents drop column zz_drop_probe'])).toBe('2BP01');
    expect(
      await inTx(su, ['alter table public.agents alter column zz_type_probe type varchar(64)']),
    ).toBe('0A000');
    // Through the runner (migrate.ts's own loop): the triggers are dropped
    // before the first pending migration, the migration applies.
    const when = 9_000_000_000_000;
    const lines: string[] = [];
    const applied = await applyJournal(
      su,
      [
        {
          folderMillis: when,
          hash: `zz-probe-${randomUUID()}`,
          sql: [
            'alter table public.agents drop column zz_drop_probe',
            'alter table public.agents alter column zz_type_probe type varchar(64)',
          ],
        },
      ],
      [{ idx: 9999, tag: '9999_zz_probe', when }],
      { log: (l) => lines.push(l), warn: (l) => lines.push(l) },
    );
    expect(applied).toBe(1);
    expect(await onAgents()).toEqual([]);
    // afterMigrations' step makes them again, the same set, from the grants.
    await applyNarrowWouldRefuse(su);
    expect(await onAgents()).toEqual(before);
    expect(await watched('zz_type_probe')).toBe(1);
    // A failed migration puts them back (best effort) and fails the run.
    const err = await applyJournal(
      su,
      [{ folderMillis: when + 1, hash: `zz-fail-${randomUUID()}`, sql: ['select 1/0'] }],
      [{ idx: 10000, tag: '10000_zz_fail', when: when + 1 }],
      { log: () => {}, warn: () => {} },
    ).then(
      () => null,
      (e: { code?: string }) => e.code ?? 'error',
    );
    expect(err).toBe('22012');
    expect(await onAgents()).toEqual(before);
    // No pending migration: nothing dropped (no table lock on a migrate
    // that applies nothing).
    expect(await applyJournal(su, [], [], { log: () => {}, warn: () => {} })).toBe(0);
    expect(await onAgents()).toEqual(before);
    await su.unsafe('alter table public.agents drop column zz_type_probe cascade');
    await applyNarrowWouldRefuse(su);
    expect(await dropNarrowWouldRefuse(su)).toBeGreaterThan(0);
    await applyNarrowWouldRefuse(su);
    expect(await onAgents()).toEqual(before);
  }, 120_000);
});
