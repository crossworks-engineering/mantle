/**
 * Advisory lock keys on a real Postgres (A10 #15): for every lock the
 * product takes, the lock the helper takes is the very lock main's inline
 * SQL took (the same pg_locks key), so two versions of the code exclude
 * each other during a roll. And the two exclude each other live: while one
 * transaction holds main's lock, the helper's try fails.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/advisory-lock.db.test.ts
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advisoryXactLock, tryAdvisoryXactLock, type AdvisoryHash } from './advisory-lock';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const ID = '0000000a-0000-4000-8000-00000000000b';

/** Each site's key text (with sample ids) and hash, as recorded on main
 *  (advisory-lock-keys.test.ts). */
const KEYS: Array<[string, AdvisoryHash]> = [
  [`app-history:${ID}`, 'hashtextextended'],
  [`accepted-snapshot:${ID}`, 'hashtextextended'],
  [`member-turn:${ID}`, 'hashtextextended'],
  [`node-seq:${ID}`, 'hashtextextended'],
  [`recall-map-create:${ID}`, 'hashtext'],
  [`chat_threads:${ID}:${ID}:${ID}`, 'hashtextextended'],
  [`access-keys:${ID}`, 'hashtext'],
  ['mantle:maintenance:entities-dedupe', 'hashtext'],
  [`oauth-actor:${ID}`, 'hashtext'],
  ['mantle_snapshot_copies', 'hashtext'],
];

describe.skipIf(!URL)('advisory lock keys on Postgres (A10 #15)', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(() => {
    client = postgres(URL!, { max: 4 });
    db = drizzle(client);
  });
  afterAll(async () => {
    await client.end();
  });

  /** The advisory lock keys this transaction holds. */
  const held = async (tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }) =>
    (await tx.execute(
      sql`select classid::text, objid::text, objsubid from pg_locks
          where locktype = 'advisory' and pid = pg_backend_pid() order by 1, 2`,
    )) as unknown as Array<{ classid: string; objid: string; objsubid: number }>;

  for (const [text, hash] of KEYS) {
    it(`${hash}(${text.replace(ID, '<id>')}): the helper's lock is main's lock`, async () => {
      const mainSql =
        hash === 'hashtext'
          ? sql`select pg_advisory_xact_lock(hashtext(${text}))`
          : sql`select pg_advisory_xact_lock(hashtextextended(${text}, 0))`;
      const onMain = await db.transaction(async (tx) => {
        await tx.execute(mainSql);
        return held(tx);
      });
      const now = await db.transaction(async (tx) => {
        await advisoryXactLock(tx, text, hash);
        return held(tx);
      });
      expect(onMain).toHaveLength(1);
      expect(now).toEqual(onMain);
    });
  }

  it("excludes main's lock live: the helper's try fails while main's is held", async () => {
    const [text, hash] = KEYS[7]!;
    let release!: () => void;
    const holding = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const isTaken = new Promise<void>((r) => (taken = r));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${text})) as locked`);
      taken();
      await holding;
    });
    await isTaken;
    const got = await db.transaction((tx) => tryAdvisoryXactLock(tx, text, hash));
    release();
    await holder;
    expect(got).toBe(false);
    expect(await db.transaction((tx) => tryAdvisoryXactLock(tx, text, hash))).toBe(true);
  });
});
