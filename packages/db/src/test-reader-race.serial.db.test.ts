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

const URL = process.env.MANTLE_TEST_DATABASE_URL;

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
