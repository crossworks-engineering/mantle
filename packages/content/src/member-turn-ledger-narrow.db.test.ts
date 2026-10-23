/**
 * The member turn ledger behind its two definers (migration 0325), on a
 * migrated scratch database with the narrow switch on:
 *
 *  - a limited member's chat request claims, counts and gives back its own
 *    slot (the cap holds), where the statements before 0325 (systemDb
 *    inside the login's request scope: the narrow route) are refused;
 *  - a request never claims for another login;
 *  - the release takes back only the scope login's own row of the last five
 *    minutes;
 *  - a forged session on the REAL narrow login, with every identity setting
 *    set to the member, clears no slot, its own or another's, and makes
 *    none: rows unchanged;
 *  - the rights: the runtime role runs the definers and only reads the
 *    table; the narrow role, the write role and the workspace role run
 *    neither and write nothing;
 *  - the revert drops both definers and takes 0325 off the ledger (last:
 *    it changes the scratch database).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/member-turn-ledger-narrow.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superuserClient } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The SQLSTATE of an error or of the database error it wraps. */
function sqlState(err: unknown): string | undefined {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined; e;) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    e = e.cause as typeof e;
  }
  return undefined;
}

describe.skipIf(!URL)('the member turn ledger on the narrow route (0325)', () => {
  let scratch: Awaited<
    ReturnType<typeof import('@mantle/db/test-support').createMigratedScratchDatabase>
  >;
  let su: ReturnType<typeof superuserClient>;
  let nl: ReturnType<typeof superuserClient>;
  let m: typeof import('@mantle/db');
  let rr: typeof import('@mantle/db/runtime-role');
  let v: typeof import('@mantle/db/viewer');
  let ledger: typeof import('./member-turn-ledger');
  let ts: typeof import('@mantle/db/test-support');
  let anchor = '';
  const pat = randomUUID();
  const sam = randomUUID();
  const ws = randomUUID();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const KEY = () => process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    su = superuserClient(scratch.url, 1);
    anchor = await ts.ensureTestAnchor(su);
    for (const id of [pat, sam]) {
      await su`insert into auth.users (id, email, password_hash, role)
               values (${id}, ${`${id}@example.test`}, 'x', 'member')`;
    }
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    rr = await import('@mantle/db/runtime-role');
    rr.setNarrowSystemForTests(true);
    v = await import('@mantle/db/viewer');
    m = await import('@mantle/db');
    ledger = await import('./member-turn-ledger');
    nl = superuserClient(
      rr.runtimeDatabaseUrl(scratch.url, rr.narrowRolePassword(KEY()), rr.NARROW_ROLE),
    );
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    rr?.setNarrowSystemForTests(null);
    for (const c of [nl, su]) await c?.end();
    await scratch?.drop();
  });

  /** `fn` in a member's own writing request (the session guard's scope). */
  const inRequest = <T>(login: string, fn: () => Promise<T>): Promise<T> =>
    m.runInRequestSlot(async () => {
      const scope = Object.freeze({
        kind: 'user' as const,
        loginId: login,
        ws: Object.freeze([ws]),
        modWs: Object.freeze([]),
      });
      expect(m.enterRequestScope(scope, { writes: true, drafts: false })).toBe(true);
      return fn();
    });
  const claim = (login: string, turn: string, dailyTurns = 2) =>
    ledger.claimMemberTurn({
      ownerId: anchor,
      loginId: login,
      turnId: turn,
      since,
      limits: { dailyTurns, dailyTokens: 0 },
    });
  const rows = async () =>
    (
      await su<{ h: string }[]>`
        select coalesce(md5(string_agg(l::text, '|' order by l.turn_id)), '') as h
          from member_turn_ledger l where l.login_id in (${pat}, ${sam})`
    )[0]!.h;

  it("a limited member's chat request claims, counts and gives back its own slot; the old statements are refused there", async () => {
    const tag = randomUUID().slice(0, 8);
    await inRequest(pat, async () => {
      // The statements before 0325: systemDb inside the login's request
      // scope takes the narrow route, which holds no right on the ledger.
      expect(v.currentRequestMode()).not.toBeNull();
      const old = await m.systemDb
        .insert(m.memberTurnLedger)
        .values({ turnId: `${tag}.old`, ownerId: anchor, loginId: pat })
        .then(
          () => 'ok',
          (e: unknown) => sqlState(e) ?? 'error',
        );
      expect(old).toBe('42501');
      // The one refusal this cell meant: taken, so the run's check (a right
      // the narrow role does not hold, met on the narrow route) sees none.
      const denied = ts.takeNarrowDenials();
      expect(denied).toHaveLength(1);
      expect(denied[0]!.what).toMatch(/permission denied for table member_turn_ledger/);
      expect(await claim(pat, `${tag}.a`)).toEqual({ ok: true, fresh: true });
      expect(await claim(pat, `${tag}.a`)).toEqual({ ok: true, fresh: false });
      expect(await claim(pat, `${tag}.b`)).toEqual({ ok: true, fresh: true });
      // The cap holds: two a day here.
      expect(await claim(pat, `${tag}.c`)).toEqual({ ok: false, reason: 'daily_cap', used: 2 });
      await ledger.releaseMemberTurn(pat, `${tag}.b`);
      expect(await claim(pat, `${tag}.d`)).toEqual({ ok: true, fresh: true });
    });
    const got = await su<{ turn_id: string; login_id: string }[]>`
      select turn_id, login_id::text as login_id from member_turn_ledger
       where turn_id like ${`${tag}.%`} order by turn_id`;
    expect(got).toEqual([
      { turn_id: `${tag}.a`, login_id: pat },
      { turn_id: `${tag}.d`, login_id: pat },
    ]);
    await su`delete from member_turn_ledger where login_id = ${pat}`;
  });

  it('a request claims for its own login only; a turn id another login holds is refused', async () => {
    const tag = randomUUID().slice(0, 8);
    const before = await rows();
    const other = await inRequest(pat, () => claim(sam, `${tag}.x`)).then(
      () => 'ok',
      (e: Error) => e.message,
    );
    expect(other).toMatch(/not the request's own/);
    expect(await rows()).toBe(before);
    await su`insert into member_turn_ledger (turn_id, owner_id, login_id)
             values (${`${tag}.sam`}, ${anchor}, ${sam})`;
    const stolen = await inRequest(pat, () => claim(pat, `${tag}.sam`)).then(
      () => 'ok',
      (e: unknown) => sqlState(e) ?? 'error',
    );
    expect(stolen).toBe('42501');
    await su`delete from member_turn_ledger where turn_id = ${`${tag}.sam`}`;
  });

  it("no login actor: the scope's login binds the call (a Telegram turn's shape); one definer call only", async () => {
    const tag = randomUUID().slice(0, 8);
    const before = await rows();
    const scope = Object.freeze({
      kind: 'user' as const,
      loginId: pat,
      ws: Object.freeze([ws]),
      modWs: Object.freeze([]),
    });
    // A system actor (no login) in pat's turn scope: a claim for sam is
    // refused before any statement; one for pat runs.
    const viaScope = await m
      .runAsActor(m.systemActor('tg-turn'), () =>
        m.withTurnScope(scope, () => claim(sam, `${tag}.s`)),
      )
      .then(
        () => 'ok',
        (e: Error) => e.message,
      );
    expect(viaScope).toMatch(/not the request's own/);
    expect(await rows()).toBe(before);
    // Another statement beside the definer call: refused before it is sent.
    const { sql } = await import('drizzle-orm');
    for (const q of [
      sql`select mantle_member_turn_release(${`${tag}.x`}::text), mantle_member_turn_release(${`${tag}.y`}::text)`,
      sql`select mantle_member_turn_release(${`${tag}.x`}::text) where pg_sleep(0) is not null`,
    ]) {
      const shaped = await inRequest(pat, () => m.loginDefinerCall(pat, 'own', q)).then(
        () => 'ok',
        (e: Error) => e.message,
      );
      expect(shaped).toMatch(/only one select of a mantle_\* definer/);
    }
    expect(await rows()).toBe(before);
  });

  it("the release takes back only the scope login's own row of the last five minutes", async () => {
    const tag = randomUUID().slice(0, 8);
    await su`insert into member_turn_ledger (turn_id, owner_id, login_id, created_at) values
      (${`${tag}.new`}, ${anchor}, ${pat}, now()),
      (${`${tag}.old`}, ${anchor}, ${pat}, now() - interval '10 minutes'),
      (${`${tag}.sam`}, ${anchor}, ${sam}, now())`;
    await inRequest(pat, async () => {
      await ledger.releaseMemberTurn(pat, `${tag}.old`);
      await ledger.releaseMemberTurn(pat, `${tag}.sam`);
      await ledger.releaseMemberTurn(pat, `${tag}.new`);
    });
    const left = await su<{ turn_id: string }[]>`
      select turn_id from member_turn_ledger where turn_id like ${`${tag}.%`} order by turn_id`;
    expect(left.map((r) => r.turn_id)).toEqual([`${tag}.old`, `${tag}.sam`]);
    await su`delete from member_turn_ledger where turn_id like ${`${tag}.%`}`;
  });

  it('a forged session on the real narrow login clears no slot and makes none, rows unchanged', async () => {
    const tag = randomUUID().slice(0, 8);
    await su`insert into member_turn_ledger (turn_id, owner_id, login_id, created_at) values
      (${`${tag}.new`}, ${anchor}, ${pat}, now()),
      (${`${tag}.old`}, ${anchor}, ${pat}, now() - interval '3 hours'),
      (${`${tag}.sam`}, ${anchor}, ${sam}, now())`;
    const before = await rows();
    const [who] = await nl<{ u: string }[]>`select session_user::text as u`;
    expect(who!.u).toBe(rr.NARROW_ROLE);
    const forge = `select set_config('mantle.scope_login', '${pat}', true),
                          set_config('mantle.login_id', '${pat}', true),
                          set_config('mantle.acting_login', '${pat}', true),
                          set_config('mantle.ws', '{${ws}}', true)`;
    const attempts = [
      `select mantle_member_turn_release('${tag}.new')`,
      `select mantle_member_turn_release('${tag}.sam')`,
      `select * from mantle_member_turn_claim('${tag}.forged', '${anchor}', now() - interval '1 hour', 1000000, 0)`,
      `delete from member_turn_ledger where login_id = '${pat}'`,
      `delete from member_turn_ledger where turn_id = '${tag}.sam'`,
      `update member_turn_ledger set created_at = now() - interval '2 days' where login_id = '${pat}'`,
      `insert into member_turn_ledger (turn_id, owner_id, login_id) values ('${tag}.forged', '${anchor}', '${pat}')`,
      `truncate member_turn_ledger`,
    ];
    for (const stmt of attempts) {
      const got = await nl
        .begin(async (t) => {
          await t.unsafe(forge);
          await t.unsafe(stmt);
        })
        .then(
          () => 'ok',
          (e: { code?: string }) => e.code ?? 'error',
        );
      expect(got, stmt).toBe('42501');
    }
    expect(await rows()).toBe(before);
    await su`delete from member_turn_ledger where turn_id like ${`${tag}.%`}`;
  });

  it('the rights: the runtime role runs the definers and reads the table; no other app role runs or writes', async () => {
    const fns = [
      'public.mantle_member_turn_claim(text,uuid,timestamp with time zone,integer,bigint)',
      'public.mantle_member_turn_release(text)',
    ];
    const roles = [
      rr.RUNTIME_ROLE,
      rr.NARROW_ROLE,
      v.viewerRoleName('write'),
      v.viewerRoleName('user'),
    ];
    const got = await su<
      { role: string; fn: string; x: boolean; s: boolean; i: boolean; u: boolean; d: boolean }[]
    >`
      select r.role, f.fn,
             has_function_privilege(r.role, f.fn, 'EXECUTE') as x,
             has_table_privilege(r.role, 'public.member_turn_ledger', 'SELECT') as s,
             has_table_privilege(r.role, 'public.member_turn_ledger', 'INSERT') as i,
             has_table_privilege(r.role, 'public.member_turn_ledger', 'UPDATE') as u,
             has_table_privilege(r.role, 'public.member_turn_ledger', 'DELETE') as d
        from unnest(${roles}::text[]) r(role), unnest(${fns}::text[]) f(fn)
       order by 1, 2`;
    for (const row of got) {
      const runtime = row.role === rr.RUNTIME_ROLE;
      expect(row.x, `${row.role} ${row.fn}`).toBe(runtime);
      expect([row.i, row.u, row.d], row.role).toEqual([false, false, false]);
      if (runtime) expect(row.s).toBe(true);
    }
    expect(got).toHaveLength(roles.length * fns.length);
  });

  it('the revert drops both definers and takes 0325 off the ledger', async () => {
    const revert = readFileSync(
      join(__dirname, '..', '..', 'db', 'rollback', '0325_member_turn_ledger_definers.revert.sql'),
      'utf8',
    );
    const state = async () =>
      (
        await su<{ fns: number; ledger: number }[]>`
          select (select count(*)::int from pg_proc
                   where proname in ('mantle_member_turn_claim', 'mantle_member_turn_release')) as fns,
                 (select count(*)::int from drizzle.__drizzle_migrations
                   where created_at = 1790198860000) as ledger`
      )[0]!;
    // The scratch database keeps no migration ledger: give it 0325's row,
    // as migrate.ts writes it.
    await su`create schema if not exists "drizzle"`;
    await su`create table if not exists "drizzle"."__drizzle_migrations" (
               id serial primary key, hash text not null, created_at bigint)`;
    await su`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
             values ('0325', 1790198860000)`;
    expect(await state()).toEqual({ fns: 2, ledger: 1 });
    await su.begin(async (t) => {
      await t.unsafe(revert);
    });
    expect(await state()).toEqual({ fns: 0, ledger: 0 });
  });
});
