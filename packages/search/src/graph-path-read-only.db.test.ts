/**
 * graphPath's walk runs readSql text inside a READ ONLY transaction
 * (simpleReadOnly), against a real, migrated Postgres:
 *  - the walk itself needs no write: it finds a two-hop path on seeded
 *    entities, outside any scope and in a turn scope;
 *  - a function readSql does not list that writes (a test-only function
 *    that inserts an entity, and one that calls nextval) passes readSql
 *    and is refused by Postgres (25006), leaving no row; the insert writes
 *    outside the read-only transaction, so the cell has teeth;
 *  - the same under asSystem with a reason the narrow system route takes
 *    ('admin-area', 'audit-log'): the read sees transaction_read_only on,
 *    as the narrow role, and a definer that inserts is refused (25006);
 *  - graphPath's own walk is sent after the SET TRANSACTION READ ONLY of
 *    its transaction, on its connection (the system pool's sends,
 *    recorded): a graphPath that stopped using simpleReadOnly fails here.
 *
 * Makes no table or sequence (a relation dropped while another file runs
 * GRANT ... ON ALL TABLES fails that file): the writers use entities and an
 * existing sequence. Seeds its own rows and functions (unique names) and
 * removes them after.
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
  const written = `${tag} written`;
  const insertFn = `${tag}_insert`;
  const nextFn = `${tag}_next`;
  /** Inserts as its owner (the superuser), so only READ ONLY stops it on
   *  the narrow route, whose role may not insert. */
  const definerFn = `${tag}_definer`;
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

    // Two writers readSql does not list.
    await su(
      `create function public.${insertFn}() returns int language sql
         as $f$ insert into public.entities (owner_id, kind, name)
                values ('${anchor}'::uuid, 'org', '${written}') returning 1 $f$`,
    );
    await su(
      `create function public.${nextFn}() returns bigint language sql
         as $f$ select nextval('public.heads_check_misses_id_seq') $f$`,
    );

    await su(
      `create function public.${definerFn}() returns int language sql security definer
         set search_path = pg_catalog, public
         as $f$ insert into public.entities (owner_id, kind, name)
                values ('${anchor}'::uuid, 'org', '${written}') returning 1 $f$`,
    );
    await su(`grant execute on function public.${definerFn}() to public`);

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
    await admin`delete from entities where owner_id = ${anchor} and name like ${`${tag} %`}`;
    await su(`drop function if exists public.${insertFn}()`);
    await su(`drop function if exists public.${nextFn}()`);
    await su(`drop function if exists public.${definerFn}()`);
    await m?.closeDb();
  });

  const writtenRows = async () =>
    Number((await admin`select count(*)::int as n from entities where name = ${written}`)[0]!.n);

  const refusal = (run: () => Promise<unknown>) =>
    run().then(
      () => null,
      (e: unknown) => e,
    );

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
      const err = await refusal(() => s.simpleReadOnly(text));
      expect(codeOf(err), `${fn}: ${String(err)}`).toBe('25006');
    }
    expect(await writtenRows()).toBe(0);
  });

  it('refuses the inserting writer in a turn scope', async () => {
    const scope = { kind: 'assistant' as const, loginId: null, ws: [randomUUID()], modWs: [] };
    const err = await refusal(() =>
      m.withTurnScope(scope, () => s.simpleReadOnly(`select public.${insertFn}() as x`)),
    );
    expect(codeOf(err), String(err)).toBe('25006');
    expect(await writtenRows()).toBe(0);
  });

  for (const reason of ['admin-area', 'audit-log'] as const) {
    it(`reads read only under asSystem('${reason}'), the narrow route`, async () => {
      const rows = (await m.asSystem(
        () =>
          s.simpleReadOnly(
            `select current_setting('transaction_read_only') as ro, current_user as u`,
          ),
        reason,
      )) as { ro: string; u: string }[];
      expect(rows[0]!.ro).toBe('on');
      expect(rows[0]!.u).toBe('mantle_system_narrow');
      const err = await refusal(() =>
        m.asSystem(() => s.simpleReadOnly(`select public.${definerFn}() as x`), reason),
      );
      expect(codeOf(err), String(err)).toBe('25006');
      expect(await writtenRows()).toBe(0);
    });
  }

  it("sends graphPath's walk inside the read-only transaction", async () => {
    const { recordSystemPoolSends, sentReadOnly } = await import('@mantle/db/test-support');
    const rec = recordSystemPoolSends();
    let out: Awaited<ReturnType<Search['graphPath']>>;
    try {
      out = await s.graphPath({ ownerId: anchor, fromId: ids.a, directed: true });
    } finally {
      rec.stop();
    }
    expect(out.length).toBeGreaterThan(0);
    const walk = rec.sent.findIndex((x) => x.text.includes('with recursive walk'));
    expect(walk, 'the walk was sent on the system pool').toBeGreaterThanOrEqual(0);
    expect(sentReadOnly(rec.sent, walk)).toBe(true);
    // The names are read after it, outside: the record tells the two apart.
    const names = rec.sent.findIndex((x, i) => i > walk && x.text.includes('from "entities"'));
    expect(names).toBeGreaterThan(walk);
    expect(sentReadOnly(rec.sent, names)).toBe(false);
  });

  it('the inserting writer writes outside a read-only transaction (the cell has teeth)', async () => {
    await admin.unsafe(`select public.${insertFn}()`);
    expect(await writtenRows()).toBe(1);
  });
});
