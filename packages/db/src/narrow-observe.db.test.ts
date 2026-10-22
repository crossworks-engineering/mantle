/**
 * The narrow write count (plan v3.2 S7a part a3, migration 0312), report
 * only, on a real, migrated Postgres with the actor check in warn:
 *
 *  - narrow-content-write: a content write by a narrow reason's actor, as
 *    the runtime role on the full route, outside a spot, is counted; at a
 *    spot, on the narrow role (refused before any trigger), inside a
 *    definer, by a rebound actor, and with the actor check off it is not.
 *  - narrow-cascade-delete: a delete from auth.users by a narrow reason's
 *    actor is counted once, on the full route and on the narrow role, its
 *    cascade into content tables never counted again.
 *  - the app's own path: with the switch off a narrow exit's content write
 *    outside a spot is counted, at a spot it is not.
 *  - the box count's query (scripts/arch-scoreboard-box.sh), and the
 *    revert (rollback/0312_narrow_write_observe.revert.sql).
 *
 * current_user = session_user: the cells that prove the predicate log in
 * as mantle_runtime (runtimeDatabaseUrl), the pool login of every fleet box,
 * which owns nothing: on the full route current_user is that login, inside
 * a definer it is the definer's owner (the superuser here), and a cascade
 * runs as mantle_owner. The tests' own pool logs in as the superuser that
 * owns the functions too, so there a definer's write would count (the named
 * limit, a cell below): the counts are exact with the runtime role on.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/narrow-observe.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyJournal } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';
import { createMigratedScratchDatabase, createScratchDatabaseBefore } from './test-support';
import {
  NARROW_ROLE,
  RUNTIME_ROLE,
  ensureRuntimeRoles,
  runtimeDatabaseUrl,
  runtimeRolePassword,
} from './runtime-role';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const KEY = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
const ROOT = join(__dirname, '..', '..', '..');
const DIR = join(__dirname, '..', 'migrations');
const TAG = '0312_narrow_write_observe';
const REVERT = join(__dirname, '..', 'rollback', `${TAG}.revert.sql`);
const PREFIX = 'mantle narrow write: ';
const WRITE = 'update public.nodes set title = title where false';

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => e.tag === TAG);

/** The settings the gateway sends with an actor (actor-sql.ts setActorSql),
 *  and the route mark of a full-route spot. */
const actorSql = (actor: string, spot = false) =>
  `select set_config('mantle.actor', '${actor}', true), set_config('mantle.write_mode', 'rw', true), ` +
  `set_config('mantle.actor_check', 'warn', true)` +
  (spot ? `, set_config('mantle.route', 'full', true)` : '');

describe.skipIf(!URL)('the narrow write count (plan v3.2 S7a part a3)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let rt: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  let v: typeof import('./viewer');
  let rr: typeof import('./runtime-role');
  let actor: typeof import('./actor');
  const notices: string[] = [];
  const counted = () => notices.splice(0).filter((n) => n.startsWith(PREFIX));

  /** Statements in one transaction on `conn`, rolled back; the first
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
    rt = postgres(runtimeDatabaseUrl(scratch.url, runtimeRolePassword(KEY)), {
      max: 1,
      prepare: false,
      onnotice: keep,
    });
    // The box in warn: the actor check triggers are enabled.
    await su`select mantle_set_actor_check('warn', 50, 'test')`;
    // A definer that writes a content table, owned by the superuser that
    // runs the migrations (as the app's definers are): this scratch only.
    await su.unsafe(`create function public.narrow_observe_definer() returns void
      language sql security definer set search_path = public, pg_temp
      as $$ ${WRITE} $$`);
    await su.unsafe(`grant execute on function public.narrow_observe_definer() to ${RUNTIME_ROLE}`);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= KEY;
    m = await import('./index');
    v = await import('./viewer');
    rr = await import('./runtime-role');
    actor = await import('./actor');
  }, 180_000);

  afterAll(async () => {
    rr?.setNarrowSystemForTests(null);
    await m?.closeDb();
    await rt?.end();
    await su?.end();
    await scratch?.drop();
  }, 60_000);

  it('the runtime role is the session and the current user on the full route, not in a definer', async () => {
    const [row] = await rt<{ u: string; s: string }[]>`select current_user as u, session_user as s`;
    expect(row).toEqual({ u: RUNTIME_ROLE, s: RUNTIME_ROLE });
    await su.unsafe(`create function public.narrow_observe_who() returns text
      language sql security definer as $$ select current_user::text $$`);
    await su.unsafe(`grant execute on function public.narrow_observe_who() to ${RUNTIME_ROLE}`);
    const [d] = await rt<{ u: string }[]>`select public.narrow_observe_who() as u`;
    expect(d!.u).not.toBe(RUNTIME_ROLE);
  });

  it('counts a narrow reason`s content write on the full route, outside a spot', async () => {
    counted();
    for (const who of ['system:http:admin-area', 'system:admin-area', 'system:http:login-self']) {
      expect(await inTx(rt, [actorSql(who), WRITE])).toBeNull();
      expect(counted(), who).toEqual([`${PREFIX}narrow-content-write ${who} nodes UPDATE`]);
    }
    // Once per table and operation in a transaction.
    expect(await inTx(rt, [actorSql('system:admin-area'), WRITE, WRITE])).toBeNull();
    expect(counted()).toHaveLength(1);
  });

  it('never counts a write at a spot, on the narrow role, in a definer, by a rebound actor, or with the check off', async () => {
    counted();
    // At a declared full-route spot (mantle.route = 'full').
    expect(await inTx(rt, [actorSql('system:http:admin-area', true), WRITE])).toBeNull();
    // On the narrow role: refused before any trigger.
    expect(
      await inTx(rt, [
        `${actorSql('system:http:admin-area')}, set_config('role', '${NARROW_ROLE}', true)`,
        WRITE,
      ]),
    ).toBe('42501');
    // Inside a definer: current_user is its owner.
    expect(
      await inTx(rt, [
        actorSql('system:http:admin-area'),
        'select public.narrow_observe_definer()',
      ]),
    ).toBeNull();
    // A rebound actor: a login, an assistant, a full reason, system work.
    for (const who of [
      `login:rw:${randomUUID()}`,
      `assistant:${randomUUID()}`,
      'system:app-data',
      'system:brain-bookkeeping',
      'system:test',
    ]) {
      expect(await inTx(rt, [actorSql(who), WRITE]), who).toBeNull();
    }
    expect(counted()).toEqual([]);
    // The actor check off: its triggers are disabled.
    await su`select mantle_set_actor_check('off', 50, 'test')`;
    try {
      expect(await inTx(rt, [actorSql('system:http:admin-area'), WRITE])).toBeNull();
      expect(counted()).toEqual([]);
    } finally {
      await su`select mantle_set_actor_check('warn', 50, 'test')`;
    }
  });

  it('the named limit: as the superuser, a superuser-owned definer`s write counts too', async () => {
    counted();
    expect(
      await inTx(su, [
        actorSql('system:http:admin-area'),
        'select public.narrow_observe_definer()',
      ]),
    ).toBeNull();
    expect(counted()).toEqual([
      `${PREFIX}narrow-content-write system:http:admin-area nodes UPDATE`,
    ]);
  });

  it('a definer`s writes are never counted on the per-database fallback (0317): the narrow role SET on the superuser`s session', async () => {
    // The per-database narrow route takes the role per transaction on the
    // system pool, whose login is the superuser that owns the definers:
    // inside one, current_user is that superuser again. 0312 counted its
    // content write and its delete; 0317 asks for the session's own role.
    await su.unsafe(`create or replace function public.narrow_observe_delete(id uuid) returns void
      language sql security definer set search_path = public, pg_temp
      as $$ delete from auth.users where id = $1 $$`);
    await su.unsafe(
      `grant execute on function public.narrow_observe_definer(), public.narrow_observe_delete(uuid) to ${NARROW_ROLE}`,
    );
    const login = async () => {
      const id = randomUUID();
      await su`insert into auth.users (id, email, password_hash, role)
               values (${id}, ${`pd-${id}@example.invalid`}, 'x', 'member')`;
      return id;
    };
    const who = 'system:http:admin-area';
    const asNarrow = `${actorSql(who)}, set_config('role', '${NARROW_ROLE}', true)`;
    counted();
    expect(await inTx(su, [asNarrow, 'select public.narrow_observe_definer()'])).toBeNull();
    expect(
      await inTx(su, [asNarrow, `select public.narrow_observe_delete('${await login()}')`]),
    ).toBeNull();
    expect(counted()).toEqual([]);
    // The narrow role's own delete there still counts (no definer).
    expect(
      await inTx(su, [asNarrow, `delete from auth.users where id = '${await login()}'`]),
    ).toBeNull();
    expect(counted()).toEqual([`${PREFIX}narrow-cascade-delete ${who} users DELETE`]);
    // With the runtime role on, a definer's delete is never counted (its
    // owner is not the session's login); as the superuser with no role
    // set, the named limit holds for both counts.
    await su.unsafe(
      `grant execute on function public.narrow_observe_delete(uuid) to ${RUNTIME_ROLE}`,
    );
    expect(
      await inTx(rt, [actorSql(who), `select public.narrow_observe_delete('${await login()}')`]),
    ).toBeNull();
    expect(counted()).toEqual([]);
    expect(
      await inTx(su, [actorSql(who), `select public.narrow_observe_delete('${await login()}')`]),
    ).toBeNull();
    expect(counted()).toEqual([`${PREFIX}narrow-cascade-delete ${who} users DELETE`]);
  });

  it('counts a delete from auth.users by a narrow reason once, on either route, never its cascade', async () => {
    const login = async () => {
      const id = randomUUID();
      await su`insert into auth.users (id, email, password_hash, role)
               values (${id}, ${`no-${id}@example.invalid`}, 'x', 'member')`;
      // A content row the delete cascades into.
      await su`insert into public.profiles (user_id) values (${id}) on conflict do nothing`;
      return id;
    };
    const del = (id: string) => `delete from auth.users where id = '${id}'`;
    counted();
    const who = 'system:http:admin-area';
    // The full route, as the runtime role.
    expect(await inTx(rt, [actorSql(who), del(await login())])).toBeNull();
    expect(counted()).toEqual([`${PREFIX}narrow-cascade-delete ${who} users DELETE`]);
    // The narrow role (it may delete a login; the cascade runs as the owner).
    expect(
      await inTx(rt, [
        `${actorSql(who)}, set_config('role', '${NARROW_ROLE}', true)`,
        del(await login()),
      ]),
    ).toBeNull();
    expect(counted()).toEqual([`${PREFIX}narrow-cascade-delete ${who} users DELETE`]);
    // Not: no row deleted, at a spot, a full reason.
    expect(await inTx(rt, [actorSql(who), del(randomUUID())])).toBeNull();
    expect(await inTx(rt, [actorSql(who, true), del(await login())])).toBeNull();
    expect(await inTx(rt, [actorSql('system:app-data'), del(await login())])).toBeNull();
    expect(counted()).toEqual([]);
  });

  it('the app`s path: with the switch off a narrow exit`s content write is counted outside a spot, not at one', async () => {
    await m.closeDb();
    rr.setNarrowSystemForTests(false);
    actor.takeNarrowWrites();
    await v.asSystem(() => m.db.execute(sql.raw(WRITE)), 'admin-area');
    expect(actor.takeNarrowWrites()).toEqual([
      {
        source: 'sql',
        check: 'narrow-content-write',
        actor: 'system:admin-area',
        detail: 'nodes UPDATE',
      },
    ]);
    await v.asSystem(
      () => v.onFullSystemRoute('profile-row', () => m.db.execute(sql.raw(WRITE))),
      'admin-area',
    );
    // A full reason, and a test's own actor.
    await v.asSystem(() => m.db.execute(sql.raw(WRITE)), 'app-data');
    await m.db.execute(sql.raw(WRITE));
    expect(actor.takeNarrowWrites()).toEqual([]);
    // Never an actor miss: the count fails no test.
    expect(actor.takeActorMisses()).toEqual([]);
    await m.closeDb();
    rr.setNarrowSystemForTests(null);
  });

  it('the box count reads distinct check, actor and table rows in its window', async () => {
    const script = readFileSync(join(ROOT, 'scripts', 'arch-scoreboard-box.sh'), 'utf8');
    const query = /^narrow=\$\(q <<SQL \|\| true\n([\s\S]*?)\nSQL$/m
      .exec(script)?.[1]
      ?.replace(/\$started/g, '');
    expect(query).toBeTruthy();
    await su`delete from public.actor_check_misses where check_name like 'narrow-%'`;
    const row = (check: string, a: string, detail: string, ago = '0 minutes') =>
      su`insert into public.actor_check_misses (at, source, check_name, actor, detail)
         values (now() - ${ago}::interval, 'sql', ${check}, ${a}, ${detail})`;
    await row('narrow-content-write', 'system:admin-area', 'nodes UPDATE');
    await row('narrow-content-write', 'system:admin-area', 'nodes UPDATE', '5 minutes');
    await row('narrow-content-write', 'system:http:admin-area', 'nodes INSERT');
    await row('narrow-cascade-delete', 'system:http:admin-area', 'users DELETE');
    await row('narrow-denied', 'system:admin-area', 'permission denied for table nodes');
    await row('narrow-content-write', 'system:admin-area', 'facts DELETE', '3 days');
    // The would-refuse count (0319): its rows, and the tables they name.
    await row('narrow-would-refuse', 'system:admin-area', 'public.audit_log DELETE');
    await row('narrow-would-refuse', 'system:http:admin-area', 'public.audit_log DELETE');
    await row('narrow-would-refuse', 'system:admin-area', 'public.agents UPDATE');
    const [out] = await su.unsafe<{ '?column?': string }[]>(query!);
    expect(Object.values(out!)[0]).toBe('2 1 1 3 2');
  });
});

describe.skipIf(!URL)('a database just before 0312 runs 0312 and only it, and its revert', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>> | undefined;
  let db: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });
  /** What 0312 changes in the catalog. */
  const catalog = async () =>
    (
      await db<{ fn: string; cascade: number; actor: string | null; stmt: string | null }[]>`
        select pg_get_functiondef('public.mantle_actor_check_stmt()'::regprocedure) as fn,
               (select count(*)::int from pg_trigger where tgname = 'mantle_narrow_cascade') as cascade,
               to_regprocedure('public.mantle_narrow_actor(text)')::text as actor,
               to_regprocedure('public.mantle_narrow_cascade_stmt()')::text as stmt`
    )[0]!;
  const ledger = async () =>
    (
      await db<{ n: number }[]>`
        select count(*)::int as n from "drizzle"."__drizzle_migrations"
         where created_at = ${journal[at]!.when}`
    )[0]!.n;
  const apply = async () => {
    const out = { lines: [] as string[], warnings: [] as string[] };
    const n = await applyJournal(db, all.slice(0, at + 1), journal.slice(0, at + 1), {
      log: (l) => out.lines.push(l),
      warn: (l) => out.warnings.push(l),
    });
    expect(out.warnings).toEqual([]);
    return n;
  };
  const revert = () =>
    readFileSync(REVERT, 'utf8')
      .split('--> statement-breakpoint')
      .map((st) => st.trim())
      .filter((st) => st.replace(/^--.*$/gm, '').trim() !== '');

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    db = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await db`create schema if not exists "drizzle"`;
    await db`create table if not exists "drizzle"."__drizzle_migrations" (
               id serial primary key, hash text not null, created_at bigint)`;
    for (const mg of all.slice(0, at)) {
      await db`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
               values (${mg.hash}, ${mg.folderMillis})`;
    }
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await scratch?.drop();
  });

  it('the runner applies 0312 and only it; the revert leaves the catalog as before; a roll forward applies it again', async () => {
    const before = await catalog();
    expect(before).toMatchObject({ cascade: 0, actor: null, stmt: null });
    expect(await apply()).toBe(1);
    const after = await catalog();
    expect(after.cascade).toBe(3);
    expect(after.fn).not.toBe(before.fn);
    expect(await ledger()).toBe(1);
    await db.begin(async (tx) => {
      for (const st of revert()) await tx.unsafe(st);
    });
    expect(await catalog()).toEqual(before);
    expect(await ledger()).toBe(0);
    expect(await apply()).toBe(1);
    expect(await catalog()).toEqual(after);
  }, 120_000);
});
