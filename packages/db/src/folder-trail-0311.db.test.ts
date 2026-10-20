/**
 * 0311: the folders above what a login reads, as structure only, through a
 * definer (mantle_folder_trail), on a migrated scratch brain on workspaces.
 *
 *  - the leak cells: a member names exactly the folders at or above a row
 *    it reads (id, path, name; no other column), never a sibling folder, a
 *    folder above only hidden rows, an empty hidden folder or a folder
 *    above another login's private row, whatever it names (children,
 *    exact paths, an id); another login of the same workspace gets its own
 *    trail; unscoped, a scope with no login and another brain get nothing;
 *  - the row rule of nodes is the one 0242 made (one SELECT rule for the
 *    workspace role), and a folder named by the trail is still no row the
 *    member reads;
 *  - the catalog: a fixed search_path, PUBLIC revoked, EXECUTE for the
 *    workspace and write roles;
 *  - the renumber proof: 0311's `when` is above every `when` before it, and
 *    a database just before it applies 0311 and only it;
 *  - the rollback: rollback/<tag>.revert.sql drops the function and takes
 *    0311 off the ledger; a roll forward applies it again.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/folder-trail-0311.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyJournal } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIR = join(__dirname, '..', 'migrations');
const TAG = '0311_folder_trail_definer';
const REVERT = join(__dirname, '..', 'rollback', `${TAG}.revert.sql`);
const FN = 'public.mantle_folder_trail(uuid,text,text[],uuid)';

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => e.tag === TAG);

const revertStatements = (): string[] =>
  readFileSync(REVERT, 'utf8')
    .split('--> statement-breakpoint')
    .map((st) => st.trim())
    .filter((st) => st.replace(/^--.*$/gm, '').trim() !== '');

describe('0311 is stamped above every `when` before it (renumber proof)', () => {
  it('is stamped above its predecessor and every earlier `when`', () => {
    expect(at).toBeGreaterThan(0);
    expect(journal[at]!.when).toBeGreaterThan(journal[at - 1]!.when);
    expect(Math.max(...journal.slice(0, at).map((e) => e.when))).toBeLessThan(journal[at]!.when);
  });

  it('the revert takes this migration off the ledger by its own `when`', () => {
    expect(readFileSync(REVERT, 'utf8')).toContain(
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${journal[at]!.when};`,
    );
  });
});

type Row = { id: string; path: string; title: string };

describe.skipIf(!URL)('0311: the folders above what a login reads (mantle_folder_trail)', () => {
  type Ts = typeof import('./test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('./index');
  let ts: Ts;
  const owner = randomUUID();
  const member = randomUUID();
  const other = randomUUID();
  const W = randomUUID();
  const tag = `ft${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  // The folders, by key: a = the way to the member's item (a.b holds it),
  // s = a hidden sibling under a (holds a hidden note), c = an empty hidden
  // folder, p = holds a row private to the other login, v = a folder the
  // workspace reads itself, and v.d under it (the grant on v passes on to
  // it, so the workspace reads it too); q = a folder private to the other
  // login that holds a note the workspace reads.
  const F: Record<
    'r' | 'a' | 'b' | 's' | 'c' | 'p' | 'q' | 'v' | 'd',
    { id: string; path: string }
  > = {
    r: { id: randomUUID(), path: tag },
    a: { id: randomUUID(), path: `${tag}.a` },
    b: { id: randomUUID(), path: `${tag}.a.b` },
    s: { id: randomUUID(), path: `${tag}.a.s` },
    c: { id: randomUUID(), path: `${tag}.c` },
    p: { id: randomUUID(), path: `${tag}.p` },
    q: { id: randomUUID(), path: `${tag}.q` },
    v: { id: randomUUID(), path: `${tag}.v` },
    d: { id: randomUUID(), path: `${tag}.v.d` },
  };
  const item = randomUUID();
  const hidden = randomUUID();
  const privateRow = randomUUID();
  const inPrivate = randomUUID();

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const trailSql = (
    o: string,
    under: string | null,
    paths: readonly string[],
    folder: string | null,
  ) => sql`select * from "public"."mantle_folder_trail"(${o}::uuid, ${under}::text,
             ${`{${paths.join(',')}}`}::text[], ${folder}::uuid) order by 2`;
  const trailAs = async (
    login: string | null,
    o: string,
    under: string | null,
    paths: readonly string[] = [],
    folder: string | null = null,
  ): Promise<Row[]> => {
    const run = async () =>
      (await m.db.execute(trailSql(o, under, paths, folder))) as unknown as Row[];
    return login ? m.withViewer({ login }, run) : run();
  };
  const keys = (rows: readonly Row[]) =>
    rows.map((r) => (Object.entries(F).find(([, f]) => f.id === r.id)?.[0] ?? r.id) as string);

  beforeAll(async () => {
    ts = await import('./test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    const su = (q: ReturnType<typeof sql>) => ts.superuserExec(scratch!.url, q);
    await x(sql`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin', true)`);
    await ts.runWorkspacesSwitch(scratch.url);
    for (const [id, who] of [
      [member, 'm'],
      [other, 'o'],
    ] as const) {
      await x(sql`insert into auth.users (id, email, password_hash, role, is_owner)
        values (${id}, ${`${tag}-${who}@example.invalid`}, 'x', 'member', false)`);
    }
    await su(
      sql`insert into workspaces (id, owner_id, name) values (${W}, ${owner}, ${`${tag} W`})`,
    );
    await su(sql`delete from workspace_users where login_id in (${member}, ${other})`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${W}, ${member}, false), (${W}, ${other}, false)`);
    for (const [key, f] of Object.entries(F)) {
      await x(sql`insert into nodes (id, owner_id, type, title, path, login_id)
        values (${f.id}, ${owner}, 'branch', ${`${tag} ${key}`}, ${f.path}::ltree,
                ${key === 'q' ? other : null})`);
    }
    await x(sql`insert into nodes (id, owner_id, type, title, path) values
      (${item}, ${owner}, 'note', ${`${tag} item`}, ${F.b.path}::ltree),
      (${hidden}, ${owner}, 'note', ${`${tag} hidden`}, ${F.s.path}::ltree)`);
    await x(sql`insert into nodes (id, owner_id, type, title, path, login_id)
      values (${privateRow}, ${owner}, 'note', ${`${tag} private`}, ${F.p.path}::ltree, ${other})`);
    await x(sql`insert into nodes (id, owner_id, type, title, path) values
      (${inPrivate}, ${owner}, 'note', ${`${tag} in private`}, ${F.q.path}::ltree)`);
    for (const id of [item, privateRow, inPrivate, F.v.id]) {
      await m.withHeads([id], 'update', async (tx) => {
        await tx.execute(sql`insert into item_grants (node_id, workspace_id) values (${id}, ${W})`);
      });
    }
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('the member reads its item, the note in q and the folders v and v.d, and no other row here (the fixture)', async () => {
    const seen = await m.withViewer(
      { login: member },
      async () =>
        (await m.db.execute(
          sql`select id::text as id from nodes where path <@ ${tag}::ltree order by path, id`,
        )) as unknown as { id: string }[],
    );
    expect(new Set(seen.map((r) => r.id))).toEqual(new Set([item, inPrivate, F.v.id, F.d.id]));
  });

  it('under a folder: only the folders one and two levels below it on the way to what the member reads, that it does not read itself', async () => {
    expect(keys(await trailAs(member, owner, F.r.path))).toEqual(['a', 'b']);
    expect(keys(await trailAs(member, owner, F.a.path))).toEqual(['b']);
    // A folder it reads it lists itself: none answered below v.
    expect(await trailAs(member, owner, F.v.path)).toEqual([]);
    expect(await trailAs(member, owner, F.d.path)).toEqual([]);
    expect(await trailAs(member, owner, F.s.path)).toEqual([]);
    expect(await trailAs(member, owner, F.b.path)).toEqual([]);
  });

  it('exact paths and ids: only folders at or above a row the member reads; the root never', async () => {
    const all = Object.values(F).map((f) => f.path);
    expect(keys(await trailAs(member, owner, null, all))).toEqual(['a', 'b', 'v', 'd']);
    expect(keys(await trailAs(member, owner, null, [], F.b.id))).toEqual(['b']);
    for (const k of ['s', 'c', 'p', 'q', 'r'] as const) {
      expect(await trailAs(member, owner, null, [], F[k].id)).toEqual([]);
    }
    expect(await trailAs(member, owner, null, [], item)).toEqual([]);
    expect(await trailAs(member, owner, null, [], randomUUID())).toEqual([]);
    expect(await trailAs(member, owner, null, [`${tag}.nope`, `${tag}.a.nope`])).toEqual([]);
  });

  it('answers id, path and name only, the names the folders have', async () => {
    const [b] = await trailAs(member, owner, null, [F.b.path]);
    expect(b).toEqual({ id: F.b.id, path: F.b.path, title: `${tag} b` });
    expect(Object.keys(b!).sort()).toEqual(['id', 'path', 'title']);
  });

  it('per login: the other login sees the folder above its private row, the member does not', async () => {
    expect(keys(await trailAs(other, owner, F.r.path))).toEqual(['a', 'b', 'p', 'q']);
    expect(keys(await trailAs(member, owner, F.r.path))).not.toContain('p');
    expect(await trailAs(member, owner, null, [F.p.path])).toEqual([]);
  });

  it("another login's own folder is never named, though it holds a row the member reads", async () => {
    expect(keys(await trailAs(member, owner, F.r.path))).not.toContain('q');
    expect(await trailAs(member, owner, null, [F.q.path])).toEqual([]);
    expect(await trailAs(member, owner, null, [], F.q.id)).toEqual([]);
    expect(keys(await trailAs(other, owner, null, [F.q.path], F.q.id))).toEqual(['q']);
  });

  it('nothing unscoped, in a scope with no login, or for another brain', async () => {
    const all = Object.values(F).map((f) => f.path);
    expect(await trailAs(null, owner, F.r.path, all, F.b.id)).toEqual([]);
    expect(await trailAs(member, randomUUID(), F.r.path, all, F.b.id)).toEqual([]);
    const noLogin = await m.withScope(
      { kind: 'user', loginId: null, ws: [W], modWs: [] },
      async () => (await m.db.execute(trailSql(owner, F.r.path, all, F.b.id))) as unknown as Row[],
    );
    expect(noLogin).toEqual([]);
  });

  it('the row rule of nodes is unchanged: a trail folder is still no row the member reads', async () => {
    const rules = await x<{ n: number }>(sql`
      select count(*)::int as n from pg_policies
       where schemaname = 'public' and tablename = 'nodes' and cmd = 'SELECT'
         and 'mantle_view_user' = any(roles)`);
    expect(rules[0]!.n).toBe(1);
    const read = await m.withViewer(
      { login: member },
      async () =>
        (await m.db.execute(
          sql`select id from nodes where id = any(${`{${F.a.id},${F.b.id}}`}::uuid[])`,
        )) as unknown as unknown[],
    );
    expect(read).toEqual([]);
  });

  it('the catalog: a definer with a fixed search_path, PUBLIC revoked, the workspace and write roles may run it', async () => {
    const [fn] = await x<{ secdef: boolean; config: string[]; acl: string }>(sql`
      select p.prosecdef as secdef, p.proconfig as config, p.proacl::text as acl
        from pg_proc p where p.oid = to_regprocedure(${FN})`);
    expect(fn!.secdef).toBe(true);
    expect(fn!.config).toEqual([
      'search_path=public, pg_temp',
      'plan_cache_mode=force_custom_plan',
    ]);
    expect(fn!.acl).not.toMatch(/(^|[{,])=X/);
    const [can] = await x<{ v: boolean; w: boolean }>(sql`
      select has_function_privilege('mantle_view_user', ${FN}, 'execute') as v,
             has_function_privilege('mantle_write_user', ${FN}, 'execute') as w`);
    expect(can).toEqual({ v: true, w: true });
  });

  it('a wide scope (over 2000 rows read below the folder): the same folders on the way one level down, each with a folder on the way below it', async () => {
    // 2001 notes in v.d, read as v.d is (the workspace's).
    await ts.superuserExec(
      scratch!.url,
      sql`insert into nodes (owner_id, type, title, path, read_ws)
          select ${owner}, 'note', 'bulk ' || i, ${F.d.path}::ltree,
                 (select read_ws from nodes where id = ${F.d.id})
            from generate_series(1, 2001) i`,
    );
    const [read] = await m.withViewer(
      { login: member },
      async () =>
        (await m.db.execute(
          sql`select count(*)::int as n from nodes where path <@ ${tag}::ltree`,
        )) as unknown as { n: number }[],
    );
    expect(read!.n).toBeGreaterThan(2000);
    expect(keys(await trailAs(member, owner, F.r.path))).toEqual(['a', 'b']);
    expect(keys(await trailAs(other, owner, F.r.path))).toEqual(['a', 'b', 'p', 'q']);
    expect(await trailAs(member, owner, F.v.path)).toEqual([]);
    expect(await trailAs(null, owner, F.r.path)).toEqual([]);
  });
});

describe.skipIf(!URL)('0311: a database just before it, and the rollback', () => {
  type Ts = typeof import('./test-support');
  let scratch: Awaited<ReturnType<Ts['createScratchDatabaseBefore']>> | undefined;
  let pg: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });
  const present = async () =>
    (
      await pg<{ n: number }[]>`select count(*)::int as n from pg_proc
                                where oid = to_regprocedure(${FN})`
    )[0]!.n;
  const ledger = async () =>
    (
      await pg<{ n: number }[]>`
        select count(*)::int as n from "drizzle"."__drizzle_migrations"
         where created_at = ${journal[at]!.when}`
    )[0]!.n;
  const apply = async () => {
    const out = { lines: [] as string[], warnings: [] as string[] };
    const n = await applyJournal(pg, all.slice(0, at + 1), journal.slice(0, at + 1), {
      log: (l) => out.lines.push(l),
      warn: (l) => out.warnings.push(l),
    });
    expect(out.warnings).toEqual([]);
    return n;
  };

  beforeAll(async () => {
    const ts: Ts = await import('./test-support');
    scratch = await ts.createScratchDatabaseBefore(URL!, TAG);
    pg = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await pg`create schema if not exists "drizzle"`;
    await pg`create table if not exists "drizzle"."__drizzle_migrations" (
               id serial primary key, hash text not null, created_at bigint)`;
    for (const mg of all.slice(0, at)) {
      await pg`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
               values (${mg.hash}, ${mg.folderMillis})`;
    }
  }, 300_000);

  afterAll(async () => {
    await pg?.end();
    await scratch?.drop();
  });

  it('the runner applies 0311 and only it', async () => {
    expect(await present()).toBe(0);
    expect(await apply()).toBe(1);
    expect(await present()).toBe(1);
  }, 120_000);

  it('rollback: the revert drops the function and takes 0311 off the ledger; a roll forward applies it again', async () => {
    expect(await ledger()).toBe(1);
    await pg.begin(async (tx) => {
      for (const st of revertStatements()) await tx.unsafe(st);
    });
    expect(await present()).toBe(0);
    expect(await ledger()).toBe(0);
    expect(await apply()).toBe(1);
    expect(await present()).toBe(1);
  }, 120_000);
});
