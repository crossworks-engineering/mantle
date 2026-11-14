/**
 * The migration of the pipeline state table (pipelines phase 2,
 * docs/pipelines.md), on a database just before it:
 *
 *  - its `when` is above every `when` before it, and the revert takes it off
 *    the ledger by that `when`;
 *  - the runner applies it and only it; the table is there, with its six
 *    columns, its key and its id check, and no trigger;
 *  - it runs a second time with no error (every statement IF NOT EXISTS);
 *  - the revert keeps the table and its rows and takes the migration off
 *    the ledger; a roll forward applies it again, and the rows are kept.
 *
 * The migration is found by its name, not its number: the integrator sets
 * the number and the `when` at merge time.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/db/src/pipeline-state-migration.db.test.ts
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
const at = journal.findIndex((e) => /^\d{4}_pipeline_state$/.test(e.tag));
const TAG = journal[at]?.tag ?? 'missing';
const MIGRATION = join(DIR, `${TAG}.sql`);
const REVERT = join(__dirname, '..', 'rollback', `${TAG}.revert.sql`);

/** A file's statements, without the comment lines. */
const statementsOf = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^--.*$/gm, '').trim())
    .filter((s) => s !== '');

describe('the pipeline state migration is stamped and revertible', () => {
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

  it('makes one table and nothing that starts work: no function, no trigger, no seed row', () => {
    const sql = statementsOf(MIGRATION).join('\n');
    expect(sql).not.toMatch(
      /\b(CREATE (OR REPLACE )?FUNCTION|TRIGGER|INSERT INTO|GRANT|NOTIFY|cron)\b/i,
    );
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(1);
    expect(statementsOf(MIGRATION)[0]).toBe("SET LOCAL lock_timeout = '30s';");
  });
});

describe.skipIf(!URL)('the pipeline state migration on a database just before it', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>> | undefined;
  let pg: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });
  const ledger = async () =>
    (
      await pg<{ n: number }[]>`
        select count(*)::int as n from "drizzle"."__drizzle_migrations"
         where created_at = ${journal[at]!.when}`
    )[0]!.n;
  const table = async () =>
    (await pg<{ t: string | null }[]>`select to_regclass('public.pipeline_state')::text as t`)[0]!
      .t;
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

  it('before it there is no table', async () => {
    expect(await table()).toBeNull();
  });

  it('the runner applies it and only it: the table, its six columns, its key, its id check, no trigger', async () => {
    expect(await apply()).toBe(1);
    expect(await table()).toBe('pipeline_state');
    expect(await ledger()).toBe(1);
    const triggers = await pg<{ tgname: string }[]>`select tgname from pg_trigger
                               where tgrelid = 'public.pipeline_state'::regclass and not tgisinternal`;
    expect(triggers).toEqual([]);
    const cols = await pg<{ c: string }[]>`select column_name as c from information_schema.columns
                               where table_schema = 'public' and table_name = 'pipeline_state'
                               order by ordinal_position`;
    expect(cols.map((r) => r.c)).toEqual([
      'owner_id',
      'pipeline_id',
      'options',
      'workspaces',
      'updated_by',
      'updated_at',
    ]);
    await pg`insert into pipeline_state (owner_id, pipeline_id, options)
             values (${OWNER}, 'site-tags', '{"not_tags":["TBD"]}'::jsonb)`;
    // One row per pipeline of a brain.
    await expect(
      pg`insert into pipeline_state (owner_id, pipeline_id) values (${OWNER}, 'site-tags')`,
    ).rejects.toThrow(/duplicate key/);
    // The id check.
    for (const bad of ['Site-Tags', '-x', '', 'a'.repeat(41), 'a b']) {
      await expect(
        pg`insert into pipeline_state (owner_id, pipeline_id) values (${OWNER}, ${bad})`,
      ).rejects.toThrow(/pipeline_state_id_ck/);
    }
    const [row] = await pg<{ options: unknown; workspaces: string[] | null }[]>`
      select options, workspaces from pipeline_state where pipeline_id = 'site-tags'`;
    expect(row).toEqual({ options: { not_tags: ['TBD'] }, workspaces: null });
  }, 120_000);

  it('runs a second time with no error, and keeps the row', async () => {
    await runFile(MIGRATION);
    await runFile(MIGRATION);
    expect(await pg`select 1 from pipeline_state where pipeline_id = 'site-tags'`).toHaveLength(1);
  }, 60_000);

  it('the revert keeps the table and its rows and takes it off the ledger; a roll forward applies it again', async () => {
    await runFile(REVERT);
    expect(await ledger()).toBe(0);
    expect(await table()).toBe('pipeline_state');
    expect(await apply()).toBe(1);
    expect(await ledger()).toBe(1);
    const [row] = await pg<{ options: unknown }[]>`
      select options from pipeline_state where pipeline_id = 'site-tags'`;
    expect(row?.options).toEqual({ not_tags: ['TBD'] });
  }, 120_000);
});
