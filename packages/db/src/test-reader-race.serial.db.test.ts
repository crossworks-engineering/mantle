/**
 * createReadOnlyRole against a schema that goes while it runs. viewer.db.test.ts
 * drops its own schema at its end, and any file that made a reader at that
 * moment lost its whole setup, on Node and on Bun alike. Gated on a throwaway
 * database:
 *   MANTLE_TEST_DATABASE_URL=postgres://postgres:…@host:port/db \
 *     pnpm vitest run packages/db/src/test-reader-race.serial.db.test.ts
 */
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createReadOnlyRole, dropReadOnlyRole } from './test-support';
import { withRoleRetry } from './viewer-roles';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('withRoleRetry on a catalog deadlock', () => {
  // A DROP OWNED and a REVOKE on all tables each change many pg_class rows in
  // one transaction. Here two grants take two tables in opposite order.
  it('runs again the side Postgres rolled back, and both end done', async () => {
    const admin = postgres(URL!, { max: 4, onnotice: () => {} });
    const tag = `role_deadlock_${process.pid}`;
    const [one, two, role] = [`${tag}_a`, `${tag}_b`, `${tag}_r`];
    await admin.unsafe(`create table ${one} (id int)`);
    await admin.unsafe(`create table ${two} (id int)`);
    await admin.unsafe(`create role ${role}`);
    let holding = 0;
    let bothHold!: () => void;
    const held = new Promise<void>((resolve) => (bothHold = resolve));
    const refused: string[] = [];
    const grant = (first: string, second: string) =>
      withRoleRetry(async () => {
        try {
          await admin.begin(async (tx) => {
            await tx.unsafe(`grant select on ${first} to ${role}`);
            holding += 1;
            if (holding === 2) bothHold();
            await held;
            await tx.unsafe(`grant select on ${second} to ${role}`);
          });
        } catch (err) {
          refused.push(String(err));
          throw err;
        }
      });
    try {
      await Promise.all([grant(one, two), grant(two, one)]);
      expect(refused.join(' ')).toMatch(/deadlock detected/);
      const [got] = await admin<{ one: boolean; two: boolean }[]>`
        select has_table_privilege(${role}, ${one}, 'select') as one,
               has_table_privilege(${role}, ${two}, 'select') as two`;
      expect(got).toEqual({ one: true, two: true });
    } finally {
      await withRoleRetry(() => admin.unsafe(`drop owned by ${role}`));
      await withRoleRetry(() => admin.unsafe(`drop role ${role}`));
      await withRoleRetry(() => admin.unsafe(`drop table ${one}, ${two}`));
      await admin.end();
    }
  }, 30_000);
});

describe.skipIf(!URL)('createReadOnlyRole while a schema comes and goes', () => {
  it('skips a schema that is gone, and still makes the reader', async () => {
    const admin = postgres(URL!, { max: 1, onnotice: () => {} });
    let running = true;
    const churn = (async () => {
      for (let n = 0; running; n++) {
        const schema = `reader_race_${process.pid}_${n}`;
        await admin.unsafe(`create schema ${schema}`);
        await admin.unsafe(`drop schema ${schema} cascade`);
      }
    })();
    try {
      for (let i = 0; i < 12; i++) {
        const reader = await createReadOnlyRole(admin, URL!);
        expect(reader.name).toMatch(/^mantle_test_reader_/);
        await dropReadOnlyRole(admin, reader.name);
      }
    } finally {
      running = false;
      await churn;
      await admin.end();
    }
  }, 120_000);
});
