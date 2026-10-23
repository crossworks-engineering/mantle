/**
 * The Admin login is role AND membership in SQL too (workspaces arch plan
 * v3.2; migration 0306_admin_membership): mantle_login_is_admin_user
 * answers its 0293 text AND mantle_login_is_admin, on a database of its own
 * (so mantle_brain_id() is this file's anchor).
 *
 *  - every login of the grid answers as 0293's text, but for the one named
 *    narrowing cell: a role=admin login outside Admin is no Admin user any
 *    more (true to false); a role=member login inside Admin stays no Admin
 *    user (false, as on main); never false to true anywhere;
 *  - mantle_access_key_revoke (a reader): a role=admin login outside Admin
 *    may no longer revoke another login's key (the narrowing, through the
 *    reader); an Admin user still may; a role=member login inside Admin
 *    still may not;
 *  - the grants are kept (PUBLIC has no EXECUTE);
 *  - the renumber proof: 0306's `when` is above every one before it and
 *    above 0305_folder_rename_write's (1790197620000), it is no longer
 *    0305 anywhere in the journal, and a
 *    database at the migration before it applies it and only it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/admin-membership.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyJournal } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';
import {
  createMigratedScratchDatabase,
  createScratchDatabaseBefore,
  ensureTestAnchor,
} from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIR = join(__dirname, '..', 'migrations');
const TAG = '0306_admin_membership';

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => e.tag === TAG);

/** 0293's mantle_login_is_admin_user body, `$1` the login. */
const MAIN_IS_ADMIN_USER = `select EXISTS (SELECT 1 FROM "auth"."users" l
                  WHERE l."id" = $1::uuid AND l."role" = 'admin' AND l."disabled_at" IS NULL) as a`;

describe('0306 is stamped above every `when` before it (renumber proof)', () => {
  it('is stamped above its predecessor and above 0305_folder_rename_write`s 1790197620000', () => {
    expect(journal.some((e) => e.tag === '0305_admin_membership')).toBe(false);
    expect(journal[at]!.idx).toBe(306);
    expect(journal[at]!.when).toBe(1790197680000);
    expect(at).toBeGreaterThan(0);
    expect(journal[at]!.when).toBeGreaterThan(journal[at - 1]!.when);
    expect(journal[at]!.when).toBeGreaterThan(1790197620000);
  });
});

describe.skipIf(!URL)('mantle_login_is_admin_user is role AND membership (S8a)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let brain = '';
  let adminWs = '';
  const tag = `am${randomUUID().slice(0, 8)}`;
  const L = {
    adm: randomUUID(), // role admin, in Admin
    dis: randomUUID(), // role admin, in Admin, disabled
    out: randomUUID(), // role admin, not in Admin (drift)
    memIn: randomUUID(), // role member, in Admin (drift)
    mem: randomUUID(), // member, not in Admin
    none: randomUUID(), // no login at all
  };
  const logins = (): Record<string, string> => ({ anchor: brain, ...L });

  const one = async (q: string, params: unknown[]): Promise<unknown> =>
    (await sql.unsafe<{ a: unknown }[]>(q, params as never[]))[0]!.a;
  /** `fn` in a transaction rolled back after. */
  const rolledBack = async <T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> => {
    let out: T | undefined;
    await sql
      .begin(async (tx) => {
        out = await fn(tx);
        throw new Error('rollback');
      })
      .catch((err: unknown) => {
        if ((err as Error).message !== 'rollback') throw err;
      });
    return out as T;
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    brain = await ensureTestAnchor(sql);
    const email = (k: string) => `${tag}-${k}@example.invalid`;
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${L.adm}, ${email('adm')}, 'x', 'admin'), (${L.dis}, ${email('dis')}, 'x', 'admin'),
      (${L.out}, ${email('out')}, 'x', 'admin'), (${L.memIn}, ${email('memin')}, 'x', 'member'),
      (${L.mem}, ${email('mem')}, 'x', 'member')`;
    await sql`update auth.users set disabled_at = now() where id = ${L.dis}`;
    await sql`insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain})
              on conflict (id) do nothing`;
    const [a] = await sql<{ id: string }[]>`
      select id::text from workspaces where owner_id = ${brain} and is_admin`;
    adminWs = a?.id ?? randomUUID();
    if (!a) {
      await sql`insert into workspaces (id, owner_id, name, is_admin)
                values (${adminWs}, ${brain}, ${`${tag} Admin`}, true)`;
    }
    await sql`insert into workspace_users (workspace_id, login_id, moderator, limits) values
      (${adminWs}, ${brain}, true, '{}'), (${adminWs}, ${L.adm}, true, '{}'),
      (${adminWs}, ${L.dis}, true, '{}'), (${adminWs}, ${L.memIn}, true, '{}')
      on conflict do nothing`;
  }, 300_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  }, 120_000);

  it('answers as 0293`s text AND mantle_login_is_admin: only the named cell narrows', async () => {
    const changed: string[] = [];
    for (const [k, id] of Object.entries(logins())) {
      const main = await one(MAIN_IS_ADMIN_USER, [id]);
      const member = await one('select mantle_login_is_admin($1::uuid) as a', [id]);
      const now = await one('select mantle_login_is_admin_user($1::uuid) as a', [id]);
      expect(now, k).toBe(main === true && member === true);
      if (now !== main) changed.push(`${k}: ${String(main)} -> ${String(now)}`);
    }
    // The one changed answer, and it narrows.
    expect(changed).toEqual(['out: true -> false']);
    expect(await one('select mantle_login_is_admin_user($1::uuid) as a', [brain])).toBe(true);
    expect(await one('select mantle_login_is_admin_user($1::uuid) as a', [L.adm])).toBe(true);
    expect(await one('select mantle_login_is_admin_user($1::uuid) as a', [L.memIn])).toBe(false);
  });

  it('mantle_access_key_revoke: a role=admin login outside Admin revokes only its own keys now', async () => {
    const revokeBy = (who: string) =>
      rolledBack(async (tx) => {
        const key = randomUUID();
        await tx`insert into access_keys (id, name, login_id, key_prefix, key_hash, access)
                 values (${key}, ${tag}, ${L.mem}, ${key.replace(/-/g, '').slice(0, 8)},
                         ${createHash('sha256').update(key).digest('hex')}, 'read')`;
        // No scope: the acting login the gateway sends must be `who` (0315).
        await tx`select set_config('mantle.acting_login', ${who}, true)`;
        const got = await tx<{ id: string }[]>`
          select id::text from mantle_access_key_revoke(${key}::uuid, ${who}::uuid)`;
        return got.length;
      });
    expect(await revokeBy(L.adm)).toBe(1); // an Admin user: any key, as on main
    expect(await revokeBy(L.out)).toBe(0); // the named narrowing (main: 1)
    expect(await revokeBy(L.memIn)).toBe(0); // member-negative, as on main
    expect(await revokeBy(L.none)).toBe(0); // no login, as on main
    expect(await revokeBy(L.mem)).toBe(1); // its own key, as on main
  });

  it('keeps its grants: PUBLIC may not EXECUTE it', async () => {
    const [r] = await sql<{ pub: boolean }[]>`
      select has_function_privilege('public', 'public.mantle_login_is_admin_user(uuid)', 'EXECUTE') as pub`;
    expect(r!.pub).toBe(false);
  });
});

describe.skipIf(!URL)('a database at the migration before 0306 runs 0306 and only it', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>> | undefined;
  let sql: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });
  const body = async () =>
    (
      await sql<{ src: string }[]>`
        select prosrc as src from pg_proc where proname = 'mantle_login_is_admin_user'`
    )[0]!.src;

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await sql`create schema if not exists "drizzle"`;
    await sql`create table if not exists "drizzle"."__drizzle_migrations" (
                id serial primary key, hash text not null, created_at bigint)`;
    for (const mg of all.slice(0, at)) {
      await sql`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
                values (${mg.hash}, ${mg.folderMillis})`;
    }
  }, 300_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('the runner applies 0306 and only it, and again it is a no-op', async () => {
    expect(await body()).not.toContain('mantle_login_is_admin"(login)');
    const out = { lines: [] as string[], warnings: [] as string[] };
    const applied = await applyJournal(sql, all.slice(0, at + 1), journal.slice(0, at + 1), {
      log: (l) => out.lines.push(l),
      warn: (l) => out.warnings.push(l),
    });
    expect(applied).toBe(1);
    expect(out.warnings).toEqual([]);
    expect(await body()).toContain('"public"."mantle_login_is_admin"(login)');
    // Re-runnable: its statements again change nothing.
    const again = readFileSync(join(DIR, `${TAG}.sql`), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    await sql.begin(async (tx) => {
      for (const st of again) await tx.unsafe(st);
    });
    expect(await body()).toContain('"public"."mantle_login_is_admin"(login)');
  }, 120_000);

  it('grants the public demo`s reader the three login facts, where it exists', async () => {
    const grant = readFileSync(join(DIR, `${TAG}.sql`), 'utf8')
      .split('--> statement-breakpoint')
      .find((st) => st.includes('DO $$') && st.includes('demo_reader'))!;
    const fns = [
      'public.mantle_login_is_admin(uuid)',
      'public.mantle_login_areas(uuid)',
      'public.mantle_area_rule(uuid,text)',
    ];
    // In a transaction rolled back after: a role is the cluster's, and no
    // other file may meet it.
    const got = await sql
      .begin(async (tx) => {
        const had = await tx`select 1 from pg_roles where rolname = 'demo_reader'`;
        if (had.length === 0) await tx`create role demo_reader nologin`;
        await tx.unsafe(grant);
        const rows = await tx<{ ok: boolean }[]>`
          select has_function_privilege('demo_reader', to_regprocedure(f), 'EXECUTE') as ok
            from unnest(${fns}::text[]) f`;
        throw Object.assign(new Error('rollback'), { rows });
      })
      .catch((err: { message: string; rows?: { ok: boolean }[] }) => {
        if (err.message !== 'rollback') throw err;
        return err.rows!;
      });
    expect(got.map((r) => r.ok)).toEqual([true, true, true]);
  });
});
