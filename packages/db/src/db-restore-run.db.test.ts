/**
 * scripts/db-restore.sh, run for real (restore rehearsal, 2026-10-01).
 *
 * server/web/lib/db-restore-script.test.ts reads the script's text. This
 * runs it: against a throwaway Postgres container of its own, with dumps of
 * six brains, and checks the exit code, what it says and what the restored
 * database holds.
 *
 *   new      a brain at 0212                              exit 0, no error
 *   old      a brain at 0210, with 0204's trigger         exit 0: the one
 *            (every dump taken before 0212)               error is explained
 *                                                         and the trigger is
 *                                                         made as 0212 does
 *   gone     a brain at 0210 that had lost the trigger    exit 0: made
 *   nofn     the same, and the trigger cannot be made     exit 2: missing
 *   another  a brain at 0212 with one more trigger a      exit 2: missing
 *            restore cannot make
 *   mixed    `old`, plus a table a restore cannot make    exit 3: the known
 *                                                         error is not
 *                                                         counted, the rest
 *                                                         is
 *
 * The script works through `docker exec` on a container whose `postgres`
 * database it replaces, so the target is a container this test starts (the
 * image of the test server's own container) and removes. It needs the test
 * database to run in a local Docker container (CI and the workstation do);
 * without one it fails on CI and is skipped elsewhere.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/db-restore-run.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { isCi } from './test-env-guard';
import {
  createMigratedScratchDatabase,
  ensureTestAnchor,
  findPgTools,
  runCommand,
} from './test-support';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;
const ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'db-restore.sh');
const MIGRATIONS = join(__dirname, '..', 'migrations');
const VARIANTS = ['new', 'old', 'gone', 'nofn', 'another', 'mixed'] as const;
type Variant = (typeof VARIANTS)[number];

const tools = DB_URL ? findPgTools(DB_URL, process.env.MANTLE_TEST_PG_CONTAINER) : null;
const source = tools?.container ?? null;

const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ tag: string; when: number }>;
};
const WHEN_0212 = journal.entries.find((e) => e.tag.startsWith('0212_'))!.when;

/** 0204's CREATE TRIGGER, as every brain before 0212 holds it. */
const TRIGGER_0204 = readFileSync(join(MIGRATIONS, '0204_folder_sharing.sql'), 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .find((s) => s.includes('CREATE TRIGGER "nodes_share_refresh_after"'))!;

describe.skipIf(!DB_URL || (!source && !isCi()))('scripts/db-restore.sh, run for real', () => {
  let base: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  const target = `mantle_restore_test_${randomUUID().slice(0, 8)}`;
  /** Where the dumps go; made in setup, so a skipped run leaves nothing. */
  let dir = '';
  let targetStarted = false;

  const inTarget = (statement: string) => {
    const r = runCommand('docker', [
      'exec',
      target,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      statement,
    ]);
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.toString().trim();
  };

  /** Restore a variant's dump into a pristine target, as an operator would. */
  const restore = (variant: Variant) => {
    // The script refuses a target that holds logins: start from an empty one.
    const reset = runCommand('docker', [
      'exec',
      target,
      'psql',
      '-U',
      'postgres',
      '-d',
      'template1',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'DROP DATABASE IF EXISTS postgres WITH (FORCE)',
      '-c',
      'CREATE DATABASE postgres',
    ]);
    expect(reset.status, reset.stderr).toBe(0);
    const r = runCommand('bash', [SCRIPT, join(dir, `mantle-${variant}.dump`)], {
      cwd: ROOT,
      env: { ...process.env, MANTLE_PG_CONTAINER: target, MANTLE_DATA_DIR: join(dir, 'data') },
    });
    const out = `${r.stdout.toString()}\n${r.stderr}`;
    // The script keeps the pg_restore output when it ends 2 or 3.
    const kept = out.match(/The full pg_restore output is kept in (\S+)/)?.[1];
    return { status: r.status, out, kept };
  };
  const shareTrigger = () =>
    inTarget(`select coalesce(max(pg_get_triggerdef(oid)), 'none') from pg_trigger
               where tgname = 'nodes_share_refresh_after' and tgrelid = 'public.nodes'::regclass`);

  beforeAll(async () => {
    if (!source) {
      throw new Error(
        'the test database does not run in a local Docker container: db-restore.sh cannot be ' +
          'run (MANTLE_TEST_PG_CONTAINER names the container when the lookup by port fails)',
      );
    }
    dir = mkdtempSync(join(tmpdir(), 'mantle-restore-test-'));
    // One migrated brain with a login.
    base = await createMigratedScratchDatabase(DB_URL!);
    const seed = postgres(base.url, { max: 1, onnotice: () => {} });
    try {
      await ensureTestAnchor(seed);
      // The migration ledger, as migrate.ts keeps it (the scratch helper
      // runs the migrations without one): the script judges a dump by it.
      await seed`create schema if not exists "drizzle"`;
      await seed`
        create table "drizzle"."__drizzle_migrations" (
          id serial primary key, hash text not null, created_at bigint)`;
      for (const e of journal.entries) {
        await seed`
          insert into "drizzle"."__drizzle_migrations" (hash, created_at)
          values (${e.tag}, ${e.when})`;
      }
    } finally {
      await seed.end();
    }
    // The six brains are made one after the other in the same database,
    // each dumped before the next change: no copy of the database is needed.
    const dropTrigger = 'DROP TRIGGER "nodes_share_refresh_after" ON "public"."nodes"';
    // The ledger of a brain that has not run 0212.
    const before0212 = `DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= ${WHEN_0212}`;
    const steps: Array<[Variant, string[]]> = [
      ['new', []],
      [
        'another',
        [
          `CREATE TRIGGER "zz_other_lost" AFTER UPDATE OF "path" ON "public"."nodes" FOR EACH ROW
             WHEN (OLD."path" IS DISTINCT FROM NEW."path")
             EXECUTE FUNCTION "public"."mantle_nodes_refresh_trg"()`,
        ],
      ],
      [
        'old',
        ['DROP TRIGGER "zz_other_lost" ON "public"."nodes"', dropTrigger, TRIGGER_0204, before0212],
      ],
      [
        'mixed',
        ['CREATE TABLE public.zz_unrestorable (p ltree, q ltree, CHECK (p IS DISTINCT FROM q))'],
      ],
      ['gone', ['DROP TABLE public.zz_unrestorable', dropTrigger]],
      ['nofn', ['DROP FUNCTION "public"."mantle_nodes_refresh_trg"()']],
    ];
    expect(steps.map(([variant]) => variant).sort()).toEqual([...VARIANTS].sort());
    const sql = postgres(base.url, { max: 1, onnotice: () => {} });
    try {
      for (const [variant, changes] of steps) {
        for (const statement of changes) await sql.unsafe(statement);
        const dump = tools!.run('pg_dump', base.name, ['-Fc', '--no-owner']);
        expect(dump.status, `pg_dump of ${variant} failed: ${dump.stderr}`).toBe(0);
        writeFileSync(join(dir, `mantle-${variant}.dump`), dump.stdout);
      }
    } finally {
      await sql.end();
    }

    // The target: a new server on the image the test server runs.
    const image = runCommand('docker', ['inspect', '-f', '{{.Config.Image}}', source])
      .stdout.toString()
      .trim();
    expect(image).toBeTruthy();
    const started = runCommand('docker', [
      'run',
      '-d',
      '--name',
      target,
      '-e',
      'POSTGRES_PASSWORD=restore-test',
      image,
    ]);
    expect(started.status, started.stderr).toBe(0);
    targetStarted = true;
    // The image's first server listens on the socket only while it sets the
    // cluster up; the real one answers on TCP.
    const deadline = Date.now() + 90_000;
    for (;;) {
      const ready = runCommand('docker', ['exec', target, 'pg_isready', '-h', '127.0.0.1']);
      if (ready.status === 0) break;
      if (Date.now() > deadline) throw new Error(`the target container never came up: ${target}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 300_000);

  afterAll(async () => {
    if (targetStarted) runCommand('docker', ['rm', '-f', target]);
    await base?.drop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it('new: a dump at 0212 restores with no error and says "Restore complete"', () => {
    const r = restore('new');
    expect(r.out).not.toMatch(/pg_restore: error/);
    expect(r.out).toMatch(/✔ Restore complete: public\.nodes has \d+ rows, auth\.users 1\./);
    expect(r.status, r.out).toBe(0);
    expect(shareTrigger()).toMatch(/\(old\.path\)::text IS DISTINCT FROM \(new\.path\)::text/);
  }, 120_000);

  it('old: a dump from before 0212 gives the one known error; the trigger is made and the restore is complete', () => {
    const r = restore('old');
    expect(r.out).toMatch(/pg_restore exited 1 with 1 error\(s\)/);
    expect(r.out).toMatch(/^Command was: CREATE TRIGGER nodes_share_refresh_after /m);
    expect(r.out).toMatch(/Made it, as 0212 does\./);
    expect(r.out).toMatch(
      /✔ Restore complete: .*\(the one pg_restore error above is explained and repaired\)\./,
    );
    expect(r.status, r.out).toBe(0);
    expect(shareTrigger()).toMatch(/\(old\.path\)::text IS DISTINCT FROM \(new\.path\)::text/);
  }, 120_000);

  it('gone: a dump of a brain that had already lost the trigger gets it too', () => {
    const r = restore('gone');
    expect(r.out).not.toMatch(/pg_restore: error/);
    expect(r.out).toMatch(/Made it, as 0212 does\./);
    expect(r.out).toMatch(/✔ Restore complete: public\.nodes has \d+ rows, auth\.users 1\./);
    expect(r.status, r.out).toBe(0);
    expect(shareTrigger()).not.toBe('none');
  }, 120_000);

  it('nofn: when the trigger cannot be made the restore fails (exit 2), with the reason, and never says complete', () => {
    const r = restore('nofn');
    expect(r.out).toMatch(/could not make the trigger nodes_share_refresh_after:/);
    expect(r.out).toMatch(/function public\.mantle_nodes_refresh_trg\(\) does not exist/);
    expect(r.out).toMatch(/✗ Restore FAILED/);
    expect(r.out).toMatch(/the trigger nodes_share_refresh_after on public\.nodes is missing/);
    expect(r.out).not.toMatch(/Restore complete/);
    expect(r.status, r.out).toBe(2);
    expect(shareTrigger()).toBe('none');
    // The pg_restore output is kept for the operator.
    expect(r.kept && existsSync(r.kept), r.out).toBe(true);
    rmSync(r.kept!, { force: true });
  }, 120_000);

  it('another: any other trigger a restore cannot make fails the restore (exit 2) by name', () => {
    const r = restore('another');
    expect(r.out).toMatch(/pg_restore exited 1 with 1 error\(s\)/);
    expect(r.out).toMatch(/✗ Restore FAILED/);
    expect(r.out).toMatch(/the trigger zz_other_lost on public\.nodes is missing/);
    expect(r.out).not.toMatch(/Restore complete/);
    expect(r.status, r.out).toBe(2);
    expect(r.kept && existsSync(r.kept), r.out).toBe(true);
    rmSync(r.kept!, { force: true });
  }, 120_000);

  it('mixed: an error the script cannot explain ends 3 after the last step; the known one is not counted', () => {
    const r = restore('mixed');
    // Three errors: the known trigger, the table and the COPY into it.
    expect(r.out).toMatch(/pg_restore exited 1 with 3 error\(s\)/);
    expect(r.out).toMatch(/Made it, as 0212 does\./);
    expect(r.out).toMatch(/pg_restore reported 2 error\(s\) this script cannot explain/);
    expect(r.out).not.toMatch(/Restore complete/);
    expect(r.out).not.toMatch(/Restore FAILED/);
    // The steps after the checks still ran.
    expect(r.out).toMatch(/Client sign-in: revoked \d+ open sign-in link/);
    expect(r.out).not.toMatch(/Next: {2}docker compose up/);
    expect(r.status, r.out).toBe(3);
    expect(shareTrigger()).not.toBe('none');
    expect(r.kept && existsSync(r.kept), r.out).toBe(true);
    rmSync(r.kept!, { force: true });
  }, 120_000);
});
