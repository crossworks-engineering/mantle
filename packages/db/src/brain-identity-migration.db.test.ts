/**
 * Migration 0226 brain_identity, on a real migrated Postgres: one row, a
 * random uuid, a second run of the migration keeps the id the first made,
 * and a second row cannot exist. The re-run happens inside ONE transaction
 * that is rolled back, so no other test file sees a change.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/brain-identity-migration.db.test.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;
type Sql = ((strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>) & {
  unsafe: (q: string) => Promise<Row[]>;
  begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function migration(): string {
  const dir = join(__dirname, '..', 'migrations');
  const name = readdirSync(dir).find((f) => f.endsWith('_brain_identity.sql'))!;
  return readFileSync(join(dir, name), 'utf8');
}

class Rollback extends Error {}

describe.skipIf(!URL)('migration brain_identity', () => {
  let admin: Sql;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    const m = await import('./index');
    admin = (m.systemDb as unknown as { $client: Sql }).$client;
  }, 60_000);

  it('made exactly one row holding a random uuid', async () => {
    const rows = await admin`select singleton, brain_id::text as id from brain_identity`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!['singleton']).toBe(true);
    expect(String(rows[0]!['id'])).toMatch(UUID_RE);
  });

  it('running it again keeps the id, and a second row is refused', async () => {
    const [before] = await admin`select brain_id::text as id from brain_identity`;
    try {
      await admin.begin(async (tx) => {
        for (const stmt of migration().split('--> statement-breakpoint')) {
          await tx.unsafe(stmt);
        }
        const after = await tx`select brain_id::text as id from brain_identity`;
        expect(after).toHaveLength(1);
        expect(after[0]).toEqual(before);
        // false is refused by the check, true by the primary key.
        await expect(tx`insert into brain_identity (singleton) values (false)`).rejects.toThrow();
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    try {
      await admin.begin(async (tx) => {
        await expect(tx`insert into brain_identity (singleton) values (true)`).rejects.toThrow();
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    const [still] = await admin`select brain_id::text as id from brain_identity`;
    expect(still).toEqual(before);
  });
});
