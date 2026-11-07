/**
 * The 0365 and 0366 rollbacks on a fresh migrated brain (the access
 * matrix's edit check triggers made by the migrate's sync, as on a box):
 *
 *  - 0365: the edit check's column trigger on apps names
 *    draft_agent_edited, so the revert rebuilds it without the column,
 *    keeping its note and its enabled state, then drops the column without
 *    CASCADE, and takes 0365 off the ledger;
 *  - 0366: function bodies only; the revert puts the three back and takes
 *    0366 off the ledger.
 * Each revert runs as the operator runs it (one transaction, the whole
 * file), and is rolled back after it is read.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/rollback-0365-0366.db.test.ts
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const ROLLED_BACK = 'rolled back';

describe.skipIf(!URL)('the 0365 and 0366 rollbacks', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
  }, 240_000);

  afterAll(async () => {
    await su?.end();
    await scratch?.drop();
  });

  const revertOf = (name: string) =>
    readFileSync(new globalThis.URL(`../rollback/${name}.revert.sql`, import.meta.url), 'utf8');

  /** Run `body` in a transaction that is rolled back after it. */
  const inRolledBack = async (body: (tx: postgres.TransactionSql) => Promise<void>) => {
    await su
      .begin(async (tx) => {
        await tx`create schema if not exists "drizzle"`;
        await tx`create table if not exists "drizzle"."__drizzle_migrations" (
          id serial primary key, hash text not null, created_at bigint)`;
        await body(tx);
        throw new Error(ROLLED_BACK);
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== ROLLED_BACK) throw err;
      });
  };

  type Trigger = { name: string; def: string; enabled: string; note: string | null };
  const triggers = async (
    tx: postgres.TransactionSql | ReturnType<typeof postgres>,
  ): Promise<Trigger[]> =>
    tx<Trigger[]>`
      select tg.tgname::text as name, pg_get_triggerdef(tg.oid) as def,
             tg.tgenabled::text as enabled, obj_description(tg.oid, 'pg_trigger') as note
        from pg_trigger tg
       where tg.tgrelid = 'public.apps'::regclass and not tg.tgisinternal
         and tg.tgname like 'mantle\\_edit\\_check\\_%'
       order by tg.tgname`;

  it('0365: the column trigger is rebuilt without the column, then the column goes', async () => {
    const before = await triggers(su);
    const cols = before.find((t) => t.name === 'mantle_edit_check_cols_manage');
    // The migrate's sync made it with the column (the precondition the
    // plain DROP COLUMN failed on).
    expect(cols?.def).toContain('draft_agent_edited');
    let after: Trigger[] = [];
    let column = -1;
    let ledger = -1;
    await inRolledBack(async (tx) => {
      await tx`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
        values ('0365', 1791583503000)`;
      await tx.unsafe(revertOf('0365_app_draft_agent_edited'));
      after = await triggers(tx);
      column = (
        await tx<{ n: number }[]>`select count(*)::int as n from information_schema.columns
          where table_schema = 'public' and table_name = 'apps'
            and column_name = 'draft_agent_edited'`
      )[0]!.n;
      ledger = (
        await tx<{ n: number }[]>`select count(*)::int as n from "drizzle"."__drizzle_migrations"
          where created_at = 1791583503000`
      )[0]!.n;
    });
    expect(column).toBe(0);
    expect(ledger).toBe(0);
    // Every edit check trigger is still there, by the same names, with the
    // same enabled state and note; none names the column.
    expect(after.map((t) => t.name)).toEqual(before.map((t) => t.name));
    for (const t of after) {
      const was = before.find((b) => b.name === t.name)!;
      expect(t.def, t.name).not.toContain('draft_agent_edited');
      expect(t.enabled, t.name).toBe(was.enabled);
      expect(t.note, t.name).toBe(was.note);
    }
    const rebuilt = after.find((t) => t.name === 'mantle_edit_check_cols_manage')!;
    // The other code columns are still watched.
    expect(rebuilt.def).toContain('draft_source');
    expect(rebuilt.def).toContain('old.draft_source IS DISTINCT FROM new.draft_source');
    // Nothing changed outside the rolled-back transaction.
    expect((await triggers(su)).find((t) => t.name === 'mantle_edit_check_cols_manage')!.def).toBe(
      cols!.def,
    );
  });

  it('0366: the three functions go back to their bodies, and 0366 leaves the ledger', async () => {
    const body = (tx: postgres.TransactionSql | ReturnType<typeof postgres>, fn: string) =>
      tx<{ src: string; definer: boolean; path: string | null }[]>`
        select p.prosrc as src, p.prosecdef as definer,
               array_to_string(p.proconfig, ',') as path
          from pg_proc p where p.proname = ${fn} and p.pronamespace = 'public'::regnamespace`;
    const fns = [
      'mantle_share_with_contacts_rows',
      'mantle_grant_change',
      'mantle_grant_move_home',
    ];
    const now: Record<string, { src: string; definer: boolean; path: string | null }> = {};
    for (const fn of fns) now[fn] = (await body(su, fn))[0]!;
    for (const fn of fns) expect(now[fn]!.src, fn).toContain('(0366)');
    const back: typeof now = {};
    let ledger = -1;
    await inRolledBack(async (tx) => {
      await tx`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
        values ('0366', 1791583563000)`;
      await tx.unsafe(revertOf('0366_login_items_not_shared'));
      for (const fn of fns) back[fn] = (await body(tx, fn))[0]!;
      ledger = (
        await tx<{ n: number }[]>`select count(*)::int as n from "drizzle"."__drizzle_migrations"
          where created_at = 1791583563000`
      )[0]!.n;
    });
    expect(ledger).toBe(0);
    for (const fn of fns) {
      expect(back[fn]!.src, fn).not.toContain('(0366)');
      // The same security attributes and search_path.
      expect(back[fn]!.definer, fn).toBe(now[fn]!.definer);
      expect(back[fn]!.path, fn).toBe(now[fn]!.path);
    }
  });
});
