/**
 * Migration 0401 (plan page 0f5ce59b, the S2 audit's follow-up N4): the
 * structure definer mantle_structure_item (0316) no longer takes the kind
 * 'secret-item'. On a database just before it:
 *
 *  - before: the function's source names the kind (its two lines);
 *  - the runner applies 0401 and only it: the source names the kind nowhere,
 *    the Secrets root stays, and the function is the same one (its owner,
 *    its grants, SECURITY DEFINER and its SET clauses are as they were);
 *  - re-runnable: its statements a second time change nothing;
 *  - the rollback: rollback/<tag>.revert.sql puts the two lines back (the
 *    source is what it was before 0401, byte for byte), twice the same, and
 *    takes 0401 off the ledger; a roll forward applies it again.
 *
 * What the definer then refuses is in structure-item.db.test.ts.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/db/src/structure-item-no-secret-0401.db.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyJournal } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIR = join(__dirname, '..', 'migrations');
const TAG = '0401_structure_item_no_secret';
const REVERT = join(__dirname, '..', 'rollback', `${TAG}.revert.sql`);
const FN = 'public.mantle_structure_item(text,text,uuid,uuid,uuid[],jsonb)';

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => e.tag === TAG);

/** The statements of a file split as the runner splits them, less the
 *  parts that are comments only. */
const statementsOf = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split('--> statement-breakpoint')
    .map((st) => st.trim())
    .filter((st) => st.replace(/^--.*$/gm, '').trim() !== '');

describe('0401 is stamped above every `when` before it (renumber proof)', () => {
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

  it('the migration and its revert name the same two lines 0316 wrote', () => {
    const made = readFileSync(join(DIR, '0316_structure_item_definer.sql'), 'utf8');
    const lines = [
      "    WHEN 'secret-item' THEN t := 'secret'; need_area := 'keys'; ops := ARRAY['insert', 'update', 'delete'];",
      "               WHEN 'secret-item' THEN place = 'secrets'::ltree",
    ];
    const revert = readFileSync(REVERT, 'utf8');
    for (const line of lines) {
      expect(made).toContain(`${line}\n`);
      // The revert writes the line as SQL text: each quote doubled.
      expect(revert).toContain(`'${line.replaceAll("'", "''")}'`);
    }
  });
});

describe.skipIf(!URL)('0401: a database just before it, and the rollback', () => {
  type Ts = typeof import('./test-support');
  let scratch: Awaited<ReturnType<Ts['createScratchDatabaseBefore']>> | undefined;
  let pg: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });
  /** The function as the catalog holds it. */
  const fn = async () =>
    (
      await pg<
        {
          src: string;
          definer: boolean;
          config: string[] | null;
          owner: string;
          acl: string | null;
        }[]
      >`select p.prosrc as src, p.prosecdef as definer, p.proconfig::text[] as config,
               p.proowner::regrole::text as owner, p.proacl::text as acl
          from pg_proc p where p.oid = to_regprocedure(${FN})`
    )[0]!;
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
  const runAll = (statements: string[]) =>
    pg.begin(async (tx) => {
      for (const st of statements) await tx.unsafe(st);
    });
  let before: Awaited<ReturnType<typeof fn>>;

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

  it('before: the function takes the kind (its two lines)', async () => {
    before = await fn();
    expect(before.src.split("WHEN 'secret-item' THEN").length - 1).toBe(2);
    expect(before.definer).toBe(true);
  });

  it('the runner applies 0401 and only it: the kind is gone, the rest of the function is as it was', async () => {
    expect(await apply()).toBe(1);
    const after = await fn();
    expect(after.src).not.toContain('secret-item');
    expect(after.src).toContain("WHEN 'secrets-root' THEN t := 'branch'");
    expect(after.src).toContain("WHEN 'secrets-root' THEN place = 'secrets'::ltree");
    // The source less the two lines, and nothing else.
    expect(after.src).toBe(
      before.src
        .split('\n')
        .filter((line) => !line.includes('secret-item'))
        .join('\n'),
    );
    // The same function: its owner, grants, SECURITY DEFINER and SET clauses.
    expect({ ...after, src: '' }).toEqual({ ...before, src: '' });
    expect(after.config?.some((c) => c.startsWith('search_path='))).toBe(true);
    expect(await apply()).toBe(0);
  }, 120_000);

  it('re-runnable: its statements a second time change nothing', async () => {
    const was = await fn();
    await runAll(statementsOf(join(DIR, `${TAG}.sql`)));
    expect(await fn()).toEqual(was);
  }, 120_000);

  it('rollback: the revert puts the two lines back and takes 0401 off the ledger; a roll forward applies it again', async () => {
    expect(await ledger()).toBe(1);
    await runAll(statementsOf(REVERT));
    expect(await fn()).toEqual(before);
    expect(await ledger()).toBe(0);
    // The revert a second time: the same end state.
    await runAll(statementsOf(REVERT));
    expect(await fn()).toEqual(before);
    expect(await apply()).toBe(1);
    expect((await fn()).src).not.toContain('secret-item');
    expect(await ledger()).toBe(1);
  }, 120_000);
});
