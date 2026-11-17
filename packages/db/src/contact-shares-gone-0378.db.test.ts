/**
 * The migration that removes contact shares (0378, owner's decision of
 * 2026-11-17), on a database just before it that looks like a live box:
 * migrate's sync has made the access matrix triggers, so the write and edit
 * checks on `shares` name every column of it, the two dropped ones too.
 *
 *  - its `when` is above every `when` before it, and the revert takes it off
 *    the ledger by that `when`;
 *  - the runner applies it: every contact share row is gone (live or
 *    revoked), the open link stays, the two tables and the two columns are
 *    gone, no contact edit check trigger is left, the contact actor is
 *    refused, and no live function body names a dropped table or column;
 *  - the sync makes its triggers on `shares` again from the shape left;
 *  - the revert puts the empty shapes back and takes it off the ledger; a
 *    roll forward applies it again.
 *
 * The migration is found by its name, not its number.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/db/src/contact-shares-gone-0378.db.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyJournal } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';
import { syncWriteRoleRules } from './access-matrix';
import { createScratchDatabaseBefore } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIR = join(__dirname, '..', 'migrations');

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => /^\d{4}_contact_shares_gone$/.test(e.tag));
const TAG = journal[at]?.tag ?? 'missing';
const MIGRATION = join(DIR, `${TAG}.sql`);
const REVERT = join(__dirname, '..', 'rollback', `${TAG}.revert.sql`);

/** A file's statements, without the comment lines. */
const statementsOf = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^--.*$/gm, '').trim())
    .filter((s) => s !== '');

describe('the contact shares migration is stamped and revertible', () => {
  it('is in the journal, above every earlier `when`', () => {
    expect(at).toBeGreaterThan(0);
    expect(Math.max(...journal.slice(0, at).map((e) => e.when))).toBeLessThan(journal[at]!.when);
  });

  it('deletes the rows before it drops the column', () => {
    const text = statementsOf(MIGRATION).join('\n');
    const del = text.indexOf('DELETE FROM "public"."shares" WHERE "contact_id" IS NOT NULL');
    const drop = text.indexOf('DROP COLUMN IF EXISTS "contact_id"');
    expect(del).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(del);
  });

  it('the revert takes this migration off the ledger by its own `when`', () => {
    expect(readFileSync(REVERT, 'utf8')).toContain(
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${journal[at]!.when};`,
    );
  });
});

describe.skipIf(!URL)('the contact shares migration on a live-like database just before it', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>> | undefined;
  let pg: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });
  const OWNER = '00000000-0000-4000-8000-0000000003a1';
  const CONTACT = '00000000-0000-4000-8000-0000000003c1';
  const PAGE = '00000000-0000-4000-8000-0000000003d1';
  const APP = '00000000-0000-4000-8000-0000000003d2';
  const OPEN = '00000000-0000-4000-8000-0000000003e1';
  const LIVE = '00000000-0000-4000-8000-0000000003e2';
  const GONE = '00000000-0000-4000-8000-0000000003e3';

  const ledger = async () =>
    (
      await pg<{ n: number }[]>`
        select count(*)::int as n from "drizzle"."__drizzle_migrations"
         where created_at = ${journal[at]!.when}`
    )[0]!.n;
  const columns = async () =>
    (
      await pg<{ c: string }[]>`select column_name as c from information_schema.columns
                               where table_schema = 'public' and table_name = 'shares'`
    ).map((r) => r.c);
  const tables = async () =>
    (
      await pg<{ t: string | null }[]>`
        select to_regclass('public.contact_share_codes')::text as t
        union all select to_regclass('public.share_access_log')::text`
    ).map((r) => r.t);
  const shareTriggers = async () =>
    (
      await pg<{ n: string }[]>`select tgname as n from pg_trigger
                               where tgrelid = 'public.shares'::regclass and not tgisinternal`
    ).map((r) => r.n);
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
    // As a live box has them: the sync's write and edit check triggers.
    await syncWriteRoleRules(pg);
    // The old world, seeded around the triggers: an open link, a live and a
    // revoked contact share, the contact's code row and a trail row.
    await pg.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into nodes (id, owner_id, type, title, path) values
                 (${CONTACT}, ${OWNER}, 'contact', 'A contact', 'contacts'),
                 (${PAGE}, ${OWNER}, 'page', 'A page', 'pages'),
                 (${APP}, ${OWNER}, 'app', 'An app', 'apps')`;
      await tx`insert into shares (id, token, owner_id, node_id, node_type, contact_id, can_write, revoked_at) values
                 (${OPEN}, 'tok-open-0378', ${OWNER}, ${PAGE}, 'page', null, false, null),
                 (${LIVE}, 'tok-live-0378', ${OWNER}, ${APP}, 'app', ${CONTACT}, true, null),
                 (${GONE}, 'tok-gone-0378', ${OWNER}, ${PAGE}, 'page', ${CONTACT}, false, now())`;
      await tx`insert into contact_share_codes (contact_id, owner_id, code_hash)
                 values (${CONTACT}, ${OWNER}, 'h')`;
      await tx`insert into share_access_log (owner_id, share_id, contact_id, kind)
                 values (${OWNER}, ${LIVE}, ${CONTACT}, 'open')`;
    });
  }, 600_000);

  afterAll(async () => {
    await pg?.end();
    await scratch?.drop();
  });

  it('before it the sync names the contact columns in its shares triggers', async () => {
    expect(await columns()).toEqual(expect.arrayContaining(['contact_id', 'can_write']));
    const named = await pg<{ n: number }[]>`
      select count(*)::int as n from pg_trigger t
        join pg_depend d on d.classid = 'pg_trigger'::regclass and d.objid = t.oid
        join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
       where t.tgrelid = 'public.shares'::regclass and a.attname in ('contact_id', 'can_write')`;
    expect(named[0]!.n).toBeGreaterThan(0);
  });

  it('the runner applies it: the contact rows, tables and columns go, the open link stays', async () => {
    expect(await apply()).toBe(1);
    expect(await ledger()).toBe(1);
    const left = await pg<{ id: string }[]>`select id::text from shares order by id`;
    expect(left.map((r) => r.id)).toEqual([OPEN]);
    expect(await columns()).not.toContain('contact_id');
    expect(await columns()).not.toContain('can_write');
    expect(await tables()).toEqual([null, null]);
    const contactTriggers = await pg<{ n: number }[]>`
      select count(*)::int as n from pg_trigger where tgname = 'mantle_edit_check_contact'`;
    expect(contactTriggers[0]!.n).toBe(0);
  }, 300_000);

  it('the contact actor is refused', async () => {
    await expect(
      pg.begin((tx) => tx`select mantle_set_actor('contact:rw', 'rw')`),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('no live function body names a dropped table or column', async () => {
    const bodies = await pg<{ f: string }[]>`
      select p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and (p.prosrc ~ 'contact_share_codes|share_access_log|can_write'
              or p.prosrc ~* '\\m[sx]\\."?contact_id"? is (not )?null')`;
    expect(bodies.map((r) => r.f)).toEqual([]);
  });

  it('the sync makes its shares triggers again from the shape left', async () => {
    await syncWriteRoleRules(pg);
    expect(await shareTriggers()).toEqual(expect.arrayContaining(['mantle_edit_check_cols_link']));
  }, 300_000);

  it('the revert puts the empty shapes back and takes it off the ledger; a roll forward applies it again', async () => {
    await runFile(REVERT);
    expect(await ledger()).toBe(0);
    expect(await columns()).toEqual(expect.arrayContaining(['contact_id', 'can_write']));
    expect(await tables()).toEqual(['contact_share_codes', 'share_access_log']);
    expect(await apply()).toBe(1);
    expect(await ledger()).toBe(1);
    expect(await columns()).not.toContain('contact_id');
    const left = await pg<{ id: string }[]>`select id::text from shares order by id`;
    expect(left.map((r) => r.id)).toEqual([OPEN]);
  }, 300_000);
});
