/**
 * The migration that turns the list of pipeline_state into an off list
 * (milestone WO, docs/pipelines.md "Where a pipeline runs"), on a database
 * just before it:
 *
 *  - its `when` is above every `when` before it, and the revert takes it off
 *    the ledger by that `when`;
 *  - it starts no work: no function, no trigger, no seed row, no grant;
 *  - the runner applies it and only it: `workspaces` is `off_in`, and a row
 *    with an old allow list has NULL after it (an allow list is never read
 *    as an off list); the options and the count of runs are kept;
 *  - a second run changes nothing: an off list set after the first run
 *    stays;
 *  - the revert clears the off lists, gives the column its old name back
 *    and takes it off the ledger; a roll forward applies it again.
 *
 * The migration is found by its name, not its number: the integrator sets
 * the number and the `when` at merge time.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/db/src/pipeline-state-off-in-migration.db.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyJournal } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';
import { createScratchDatabaseBefore } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIR = join(__dirname, '..', 'migrations');

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => /^\d{4}_pipeline_state_off_in$/.test(e.tag));
const TAG = journal[at]?.tag ?? 'missing';
const MIGRATION = join(DIR, `${TAG}.sql`);
const REVERT = join(__dirname, '..', 'rollback', `${TAG}.revert.sql`);

/** A file's statements, without the comment lines. */
const statementsOf = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^--.*$/gm, '').trim())
    .filter((s) => s !== '');

describe('the off list migration is stamped and revertible', () => {
  it('is in the journal, above every earlier `when`', () => {
    expect(at).toBeGreaterThan(0);
    expect(Math.max(...journal.slice(0, at).map((e) => e.when))).toBeLessThan(journal[at]!.when);
  });

  it('the revert takes this migration off the ledger by its own `when`, and drops nothing', () => {
    const text = readFileSync(REVERT, 'utf8');
    expect(text).toContain(
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${journal[at]!.when};`,
    );
    expect(statementsOf(REVERT).join('\n')).not.toMatch(/\bDROP\b/i);
  });

  it('starts no work: no function, no trigger, no seed row, no grant', () => {
    const sql = statementsOf(MIGRATION).join('\n');
    expect(sql).not.toMatch(
      /\b(CREATE (OR REPLACE )?FUNCTION|TRIGGER|INSERT INTO|GRANT|NOTIFY|cron)\b/i,
    );
    expect(statementsOf(MIGRATION)[0]).toBe("SET LOCAL lock_timeout = '30s';");
  });
});

describe.skipIf(!URL)('the off list migration on a database just before it', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>> | undefined;
  let pg: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });
  const ledger = async () =>
    (
      await pg<{ n: number }[]>`
        select count(*)::int as n from "drizzle"."__drizzle_migrations"
         where created_at = ${journal[at]!.when}`
    )[0]!.n;
  const columns = async () =>
    (
      await pg<{ c: string }[]>`select column_name as c from information_schema.columns
                               where table_schema = 'public' and table_name = 'pipeline_state'
                               order by ordinal_position`
    ).map((r) => r.c);
  const apply = async () => {
    const out = { lines: [] as string[], warnings: [] as string[] };
    const n = await applyJournal(pg, all.slice(0, at + 1), journal.slice(0, at + 1), {
      log: (l) => out.lines.push(l),
      warn: (l) => out.warnings.push(l),
    });
    expect(out.warnings).toEqual([]);
    return n;
  };
  const runFile = (file: string) =>
    pg.begin(async (tx) => {
      for (const st of statementsOf(file)) await tx.unsafe(st);
    });
  const OWNER = '00000000-0000-4000-8000-0000000000a1';
  const WS = '00000000-0000-4000-8000-0000000000b1';

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
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

  it('before it the column is `workspaces`, an allow list', async () => {
    expect(await columns()).toContain('workspaces');
    expect(await columns()).not.toContain('off_in');
    await pg`insert into pipeline_state (owner_id, pipeline_id, options, workspaces, runs)
             values (${OWNER}, 'site-tags', '{"not_tags":["TBD"]}'::jsonb, array[${WS}::uuid], 7),
                    (${OWNER}, 'sheet', '{}'::jsonb, null, 2)`;
  });

  it('the runner applies it and only it: off_in, every old list NULL, the rest kept, no trigger', async () => {
    expect(await apply()).toBe(1);
    expect(await ledger()).toBe(1);
    expect(await columns()).toEqual([
      'owner_id',
      'pipeline_id',
      'options',
      'off_in',
      'updated_by',
      'updated_at',
      'runs',
      'last_run_at',
    ]);
    const rows = await pg<
      { pipeline_id: string; options: unknown; off_in: string[] | null; runs: string }[]
    >`
      select pipeline_id, options, off_in, runs::text as runs
        from pipeline_state order by pipeline_id`;
    expect(rows).toEqual([
      { pipeline_id: 'sheet', options: {}, off_in: null, runs: '2' },
      { pipeline_id: 'site-tags', options: { not_tags: ['TBD'] }, off_in: null, runs: '7' },
    ]);
    const triggers = await pg<{ tgname: string }[]>`select tgname from pg_trigger
                               where tgrelid = 'public.pipeline_state'::regclass and not tgisinternal`;
    expect(triggers).toEqual([]);
  }, 120_000);

  it('a second run changes nothing: an off list set after the first run stays', async () => {
    await pg`update pipeline_state set off_in = array[${WS}::uuid] where pipeline_id = 'sheet'`;
    await runFile(MIGRATION);
    await runFile(MIGRATION);
    const [row] = await pg<{ off_in: string[] | null }[]>`
      select off_in from pipeline_state where pipeline_id = 'sheet'`;
    expect(row?.off_in).toEqual([WS]);
  }, 60_000);

  it('the revert clears the off lists, gives the old name back and takes it off the ledger; a roll forward applies it again', async () => {
    await runFile(REVERT);
    expect(await ledger()).toBe(0);
    expect(await columns()).toContain('workspaces');
    expect(await columns()).not.toContain('off_in');
    // An off list is never left for the older image to read as an allow list.
    const back = await pg<{ workspaces: string[] | null; runs: string }[]>`
      select workspaces, runs::text as runs from pipeline_state order by pipeline_id`;
    expect(back).toEqual([
      { workspaces: null, runs: '2' },
      { workspaces: null, runs: '7' },
    ]);
    expect(await apply()).toBe(1);
    expect(await ledger()).toBe(1);
    expect(await columns()).toContain('off_in');
    const [row] = await pg<{ options: unknown }[]>`
      select options from pipeline_state where pipeline_id = 'site-tags'`;
    expect(row?.options).toEqual({ not_tags: ['TBD'] });
  }, 120_000);
});
