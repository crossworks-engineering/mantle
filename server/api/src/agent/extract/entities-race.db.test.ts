/**
 * Two extractions that create the same new entity at once both link to it.
 *
 * 2026-09-29, the LoCoMo benchmark (4 notes extracted in parallel): the loser
 * of the insert race hit entities_owner_lname_kind_uq, and the handler that
 * should have re-selected the winner checked `err.code`, which drizzle's
 * wrapped error does not carry (it sits on `err.cause`). The mention was
 * dropped, so 5 speaker mentions across 19 notes had no entity edge. Against a
 * real, migrated Postgres:
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/entities-race.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('concurrent entity creation', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let reconcileEntities: typeof import('./entities').reconcileEntities;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const nodeIds = [randomUUID(), randomUUID()];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    ({ reconcileEntities } = await import('./entities'));
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`race-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict do nothing`);
    for (const [i, id] of nodeIds.entries())
      await m.db.execute(sqlTag`
        insert into nodes (id, owner_id, type, title, path)
        values (${id}, ${owner}, 'note', ${`note ${i}`}, 'notes')`);
  });

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from entity_edges where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from entities where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
  });

  it('both notes resolve every shared new name to the one winning entity', async () => {
    const nodes = await Promise.all(
      nodeIds.map(async (id) => {
        const [row] = await m.db
          .select()
          .from(m.nodes)
          .where(sqlTag`id = ${id}`);
        return row!;
      }),
    );
    const names = ['Caroline', 'Melanie', 'Oscar', 'Luna', 'Nate'];
    const mentions = names.map((name) => ({ name, kind: 'person' }));
    const [a, b] = await Promise.all(nodes.map((n) => reconcileEntities(n, owner, mentions)));
    for (const name of names) {
      const idA = a!.get(name.toLowerCase());
      const idB = b!.get(name.toLowerCase());
      expect(idA, `${name} resolved for note 0`).toBeTruthy();
      expect(idB, `${name} resolved for note 1`).toBeTruthy();
      expect(idA).toBe(idB);
    }
    const rows = (await m.db.execute(sqlTag`
      select lower(name) as n, count(*)::int as c from entities
      where owner_id = ${owner} group by 1`)) as unknown as Array<{ n: string; c: number }>;
    expect(rows).toHaveLength(names.length);
    expect(rows.every((r) => r.c === 1)).toBe(true);
  });
});
