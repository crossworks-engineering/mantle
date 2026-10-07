/**
 * Migration keep_existing_look, on a real migrated Postgres: an existing
 * profile row with no look of its own gets the OLD effective values (so the
 * brain keeps the look it shows today), a value that is present is never
 * touched, and an empty table is fine. Everything happens inside ONE
 * transaction that is rolled back, so no other test file sees a change.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/keep-existing-look-migration.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;
type Sql = ((strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>) & {
  unsafe: (q: string) => Promise<Row[]>;
  begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
};

function migrationStatements(): string[] {
  const dir = join(__dirname, '..', 'migrations');
  const name = readdirSync(dir).find((f) => f.endsWith('_keep_existing_look.sql'))!;
  return readFileSync(join(dir, name), 'utf8').split('--> statement-breakpoint');
}

class Rollback extends Error {}

/** Run `fn` in a transaction that is always rolled back. */
async function inRollback(admin: Sql, fn: (tx: Sql) => Promise<void>): Promise<void> {
  try {
    await admin.begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

async function migrate(tx: Sql): Promise<void> {
  for (const stmt of migrationStatements()) await tx.unsafe(stmt);
}

const OLD = { colorTheme: 'clean-slate', avatarStyle: 'thumbs', neatBackground: '' };

describe.skipIf(!URL)('migration keep_existing_look', () => {
  let admin: Sql;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    const m = await import('./index');
    admin = (m.systemDb as unknown as { $client: Sql }).$client;
  }, 60_000);

  it('is fine on an empty table', async () => {
    await inRollback(admin, async (tx) => {
      await tx`delete from profiles`;
      await migrate(tx);
      expect(await tx`select 1 from profiles`).toHaveLength(0);
    });
  });

  it('fills missing values with the old look and never touches a present one', async () => {
    const tag = randomUUID().slice(0, 8);
    const id = {
      bare: randomUUID(),
      chose: randomUUID(),
      off: randomUUID(),
      nulls: randomUUID(),
      blank: randomUUID(),
      member: randomUUID(),
    };
    const mine = '{"v":1,"seed":7,"tone":"darker","speed":0}';
    const prefs: Record<keyof typeof id, Record<string, unknown>> = {
      // Never chose anything, other settings intact.
      bare: { timezone: 'Africa/Johannesburg', houseStyle: 'Short sentences.' },
      // Chose all three, including the NEW defaults: kept as they are.
      chose: { colorTheme: 'jackdaw', avatarStyle: 'lorelei', neatBackground: mine },
      // Switched Neat off and chose a theme; no avatar style.
      off: { colorTheme: 'darkmatter', neatBackground: '' },
      // JSON nulls read as unset, so they are filled too.
      nulls: { colorTheme: null, avatarStyle: null, neatBackground: null },
      // Blank strings read as the old default theme and style.
      blank: { colorTheme: '', avatarStyle: '  ' },
      // A member's personal row: filled the same way (harmless, never read).
      member: {},
    };

    await inRollback(admin, async (tx) => {
      for (const [k, uid] of Object.entries(id)) {
        await tx`insert into auth.users (id, email, password_hash, role)
                 values (${uid}, ${`${tag}-${k}@example.invalid`}, 'x',
                         ${k === 'member' ? 'member' : 'admin'})`;
        await tx`insert into profiles (user_id, preferences)
                 values (${uid}, ${JSON.stringify(prefs[k as keyof typeof id])}::jsonb)`;
      }

      await migrate(tx);

      const read = async (uid: string) =>
        (await tx`select preferences from profiles where user_id = ${uid}`)[0]![
          'preferences'
        ] as Record<string, unknown>;

      expect(await read(id.bare)).toEqual({ ...prefs.bare, ...OLD });
      expect(await read(id.chose)).toEqual(prefs.chose);
      expect(await read(id.off)).toEqual({
        colorTheme: 'darkmatter',
        neatBackground: '',
        avatarStyle: 'thumbs',
      });
      expect(await read(id.nulls)).toEqual(OLD);
      expect(await read(id.blank)).toEqual({ ...OLD });
      expect(await read(id.member)).toEqual(OLD);

      // Idempotent: a second run changes nothing.
      const before = await tx`select user_id, preferences from profiles order by user_id`;
      await migrate(tx);
      expect(await tx`select user_id, preferences from profiles order by user_id`).toEqual(before);
    });
  });
});
