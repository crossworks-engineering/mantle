/**
 * graphPath's walk runs readSql text inside a READ ONLY transaction
 * (simpleReadOnly), against a real, migrated Postgres:
 *  - the walk itself needs no write: it finds a two-hop path on seeded
 *    entities, outside any scope and in a turn scope;
 *  - a function readSql does not list that writes (a test-only function
 *    that inserts, and one that calls nextval) passes readSql and is
 *    refused by Postgres (25006), and leaves nothing; the same functions
 *    write outside the read-only transaction, so the cell has teeth.
 *
 * Seeds its own rows and objects (unique names) and removes them after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/search/src/graph-path-read-only.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The SQLSTATE of a postgres.js error, or of the error it wraps. */
function codeOf(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

describe.skipIf(!URL)('graphPath reads in a READ ONLY transaction', () => {
  type Db = typeof import('@mantle/db');
  type Search = typeof import('./entities');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let s: Search;
  let admin: Admin;
  let anchor = '';
  const tag = `s10ro${randomUUID().slice(0, 8)}`;
  const table = `${tag}_t`;
  const seq = `${tag}_s`;
  const insertFn = `${tag}_insert`;
  const nextFn = `${tag}_next`;
  const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID() };

  const su = async (q: string) => (await import('@mantle/db/test-support')).superuserExec(URL!, q);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    s = await import('./entities');
    const { ensureTestAnchor, superuserClient } = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    const root = superuserClient(URL!);
    try {
      expect(await m.ensureViewerRoles(root, process.env.MANTLE_MASTER_KEY)).toBe('ok');
    } finally {
      await root.end();
    }
    anchor = await ensureTestAnchor(admin);

    // Two writers readSql does not list, open to every role.
    await su(`create table public.${table} (n int)`);
    await su(`grant all on public.${table} to public`);
    await su(`create sequence public.${seq}`);
    await su(`grant all on sequence public.${seq} to public`);
    await su(
      `create function public.${insertFn}() returns int language sql
         as $f$ insert into public.${table} values (1) returning 1 $f$`,
    );
    await su(
      `create function public.${nextFn}() returns bigint language sql
         as $f$ select nextval('public.${seq}') $f$`,
    );

    for (const [k, id] of Object.entries(ids)) {
      await admin`insert into entities (id, owner_id, kind, name)
        values (${id}, ${anchor}, 'org', ${`${tag} ${k}`})`;
    }
    await admin`insert into entity_edges (owner_id, source_id, source_kind, target_id, target_kind, relation)
      values (${anchor}, ${ids.a}, 'entity', ${ids.b}, 'entity', 'works_at'),
             (${anchor}, ${ids.b}, 'entity', ${ids.c}, 'entity', 'supplies')`;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from entity_edges where owner_id = ${anchor}
      and source_id in (${ids.a}, ${ids.b})`;
    await admin`delete from entities where id in (${ids.a}, ${ids.b}, ${ids.c})`;
    await su(`drop function if exists public.${insertFn}()`);
    await su(`drop function if exists public.${nextFn}()`);
    await su(`drop table if exists public.${table}`);
    await su(`drop sequence if exists public.${seq}`);
    await m?.closeDb();
  });

  const rowsIn = async () =>
    Number((await admin.unsafe(`select count(*)::int as n from public.${table}`))[0]!.n);
  const lastValue = async () =>
    (
      await admin.unsafe(`select last_value::text as v, is_called from public.${seq}`)
    )[0] as unknown as {
      v: string;
      is_called: boolean;
    };

  it('finds a two-hop path with no write, outside a scope', async () => {
    const out = await s.graphPath({ ownerId: anchor, fromId: ids.a, directed: true });
    const byName = new Map(out.map((r) => [r.entity.name, r.depth]));
    expect(byName.get(`${tag} b`)).toBe(1);
    expect(byName.get(`${tag} c`)).toBe(2);
  });

  it('runs the walk in a turn scope too', async () => {
    const scope = { kind: 'assistant' as const, loginId: null, ws: [randomUUID()], modWs: [] };
    const rows = await m.withTurnScope(scope, () =>
      s.simpleReadOnly(s.graphPathSql({ ownerId: anchor, fromId: ids.a, directed: true })),
    );
    expect(Array.isArray(rows)).toBe(true);
  });

  it('refuses an unlisted writer that readSql lets through', async () => {
    for (const fn of [insertFn, nextFn]) {
      const text = `select public.${fn}() as x`;
      expect(m.readSql(text)).toBe(text);
      const err = await s.simpleReadOnly(text).then(
        () => null,
        (e: unknown) => e,
      );
      expect(codeOf(err), `${fn}: ${String(err)}`).toBe('25006');
    }
    expect(await rowsIn()).toBe(0);
    expect((await lastValue()).is_called).toBe(false);
  });

  it('refuses the writers in a turn scope', async () => {
    const scope = { kind: 'assistant' as const, loginId: null, ws: [randomUUID()], modWs: [] };
    for (const fn of [insertFn, nextFn]) {
      const err = await m
        .withTurnScope(scope, () => s.simpleReadOnly(`select public.${fn}() as x`))
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(codeOf(err), `${fn}: ${String(err)}`).toBe('25006');
    }
    expect(await rowsIn()).toBe(0);
  });

  it('the same writers write outside a read-only transaction (the cell has teeth)', async () => {
    await admin.unsafe(`select public.${insertFn}()`);
    await admin.unsafe(`select public.${nextFn}()`);
    expect(await rowsIn()).toBe(1);
    expect((await lastValue()).is_called).toBe(true);
  });
});
