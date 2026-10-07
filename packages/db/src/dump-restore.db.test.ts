/**
 * A dump of a migrated brain restores whole (restore rehearsal, 2026-10-01;
 * migration 0212).
 *
 * pg_dump writes every stored expression (a trigger WHEN, a CHECK, a
 * generated column, an index, a policy, a view) back as SQL, and pg_restore
 * runs it with an empty search_path. An ordinary operator on an extension
 * type is written with its schema (OPERATOR(public.=)), but IS DISTINCT
 * FROM, NULLIF and a simple CASE cannot name the schema of the operator
 * behind them. 0204 compared an ltree column that way in the WHEN clause of
 * nodes_share_refresh_after: every restore failed on that one statement and
 * the restored brain had no such trigger. Nothing caught it, because
 * scripts/db-restore.sh goes on past a pg_restore error.
 *
 * This dumps a database migrated from scratch, with a few rows in it, with
 * `pg_dump -Fc --no-owner` and restores it into an empty one with
 * `pg_restore --no-owner`, as scripts/db-dump.sh and scripts/db-restore.sh
 * do. It asks for no pg_restore error and for the same triggers, row
 * policies, functions, constraints and indexes on both sides (names and
 * definitions, read from the catalog), and the same rows. The rows matter:
 * a restore runs every CHECK, generated column and index expression on
 * them with an empty search_path, so a function there that names something
 * without its schema fails only when there is data. A schema-only dump goes
 * through the same check. It then puts 0204's own trigger back and proves
 * that a restore of THAT loses it, so the check is known to see this kind
 * of failure.
 *
 * pg_dump and pg_restore must be at least as new as the server, so the test
 * uses the ones inside the local Docker container that publishes the test
 * database's port (how CI and the workstation run Postgres;
 * MANTLE_TEST_PG_CONTAINER names another container), and a host install
 * only when there is no such container. With neither, the test fails on CI
 * and is skipped elsewhere.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/dump-restore.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  createEmptyScratchDatabase,
  createMigratedScratchDatabase,
  ensureTestAnchor,
  findPgTools,
} from './test-support';
import { isCi } from './test-env-guard';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;
const MIGRATIONS = join(__dirname, '..', 'migrations');
const TRIGGER = 'public.nodes.nodes_share_refresh_after';

const ci = isCi();
const tools = DB_URL ? findPgTools(DB_URL, process.env.MANTLE_TEST_PG_CONTAINER) : null;

/** Every statement of a migration file. */
const statementsOf = (file: string) =>
  readFileSync(join(MIGRATIONS, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);

/** What a restore must bring back, read from the catalog: name -> definition. */
type Catalog = Record<
  'triggers' | 'policies' | 'functions' | 'constraints' | 'indexes',
  Record<string, string>
>;

async function catalogOf(url: string): Promise<Catalog> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const map = (rows: { name: string; def: string | null }[]) =>
    Object.fromEntries(rows.map((r) => [r.name, r.def ?? '']));
  type Rows = { name: string; def: string | null }[];
  try {
    // The same search_path on both sides, so both print names the same way.
    await sql`set search_path = public`;
    const ours = sql`n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')`;
    return {
      triggers: map(
        await sql<Rows>`
          select n.nspname || '.' || c.relname || '.' || t.tgname as name,
                 pg_get_triggerdef(t.oid) as def
            from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where not t.tgisinternal order by 1`,
      ),
      policies: map(
        await sql<Rows>`
          select schemaname || '.' || tablename || '.' || policyname as name,
                 cmd || ' to ' || roles::text || ' using ' || coalesce(qual, '-')
                   || ' check ' || coalesce(with_check, '-') as def
            from pg_policies order by 1`,
      ),
      // Every function by its signature; the body of each one a migration
      // made (an extension's functions come with the extension).
      functions: map(
        await sql<Rows>`
          select p.oid::regprocedure::text as name,
                 case when p.prokind in ('f', 'p') and not exists (
                        select 1 from pg_depend d
                         where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                      then pg_get_functiondef(p.oid) end as def
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where ${ours} order by 1`,
      ),
      constraints: map(
        await sql<Rows>`
          select n.nspname || '.' || c.relname || '.' || k.conname as name,
                 pg_get_constraintdef(k.oid) as def
            from pg_constraint k
            join pg_class c on c.oid = k.conrelid
            join pg_namespace n on n.oid = c.relnamespace
           where ${ours} order by 1`,
      ),
      indexes: map(
        await sql<Rows>`
          select schemaname || '.' || indexname as name, indexdef as def
            from pg_indexes i join pg_namespace n on n.nspname = i.schemaname
           where ${ours} order by 1`,
      ),
    };
  } finally {
    await sql.end();
  }
}

describe.skipIf(!DB_URL || (!tools && !ci))('a dump of a migrated brain restores whole', () => {
  type Scratch = Awaited<ReturnType<typeof createEmptyScratchDatabase>>;
  let source: Scratch | undefined;
  const targets: Scratch[] = [];
  const id = { folder: randomUUID(), file: randomUUID(), note: randomUUID() };

  /** Dump the source with pg_dump -Fc and restore it into a new, empty
   *  database. Returns the target and every pg_restore error line. */
  const dumpAndRestore = async (
    dumpArgs: string[] = [],
  ): Promise<{ target: Scratch; errors: string[]; log: string }> => {
    const dump = tools!.run('pg_dump', source!.name, ['-Fc', '--no-owner', ...dumpArgs]);
    expect(dump.status, `pg_dump failed: ${dump.stderr}`).toBe(0);
    expect(dump.stdout.length).toBeGreaterThan(0);
    const target = await createEmptyScratchDatabase(DB_URL!);
    targets.push(target);
    const restore = tools!.run('pg_restore', target.name, ['--no-owner'], dump.stdout);
    const log = `${restore.stdout.toString()}\n${restore.stderr}`;
    const errors = log.split('\n').filter((l) => l.startsWith('pg_restore: error:'));
    // pg_restore goes on past an error and exits non-zero at the end.
    if (errors.length === 0) expect(restore.status, log).toBe(0);
    return { target, errors, log };
  };

  const expectSameCatalog = async (target: Scratch) => {
    const before = await catalogOf(source!.url);
    const after = await catalogOf(target.url);
    // The check is not empty: the migrated schema has all of these.
    expect(Object.keys(before.triggers)).toContain(TRIGGER);
    expect(Object.keys(before.triggers).length).toBeGreaterThan(20);
    expect(Object.keys(before.policies)).toContain('public.nodes.nodes_viewer_read');
    expect(Object.keys(before.functions)).toContain('mantle_nodes_refresh_trg()');
    expect(Object.keys(before.constraints)).toContain('public.nodes.nodes_share_level_ck');
    expect(Object.keys(before.indexes)).toContain('public.nodes_shared_folder_idx');
    for (const kind of Object.keys(before) as (keyof Catalog)[]) {
      // Names first: a missing object reads better than a long diff.
      expect(Object.keys(after[kind]), `${kind} lost or gained by the restore`).toEqual(
        Object.keys(before[kind]),
      );
      expect(after[kind], `a definition among the ${kind} changed in the restore`).toEqual(
        before[kind],
      );
    }
  };

  /** The seeded rows a restore must bring back as they were. */
  const rowsOf = async (url: string) => {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const nodes = await sql`
        select id, type::text as type, path::text as path, share_level, inherited_level,
               data, (embedding is not null) as embedded, search_tsv::text as tsv
          from nodes order by id`;
      const chunks = await sql`
        select node_id, ordinal, text, embedding::text as embedding, search_tsv::text as tsv
          from content_chunks order by node_id, ordinal`;
      return { nodes: [...nodes], chunks: [...chunks] };
    } finally {
      await sql.end();
    }
  };

  beforeAll(async () => {
    if (!tools) {
      throw new Error(
        'no pg_dump and pg_restore for the test server: install a client at least as new as ' +
          'the server, or run Postgres in a local Docker container (MANTLE_TEST_PG_CONTAINER names it)',
      );
    }
    source = await createMigratedScratchDatabase(DB_URL!);
    // Rows that put every extension type and every function a restore runs
    // to work: ltree paths, a shared folder and a file that inherits from it
    // (the CHECKs on nodes), a vector on a node and on a chunk (the vector
    // indexes), the generated search columns, and a task and an event with
    // dates (the mantle_iso_to_ts indexes).
    const sql = postgres(source.url, { max: 1, onnotice: () => {} });
    try {
      const brain = await ensureTestAnchor(sql);
      const vector = `[${Array.from({ length: 768 }, (_, i) => (i % 7) / 10).join(',')}]`;
      const node = (
        nodeId: string,
        type: string,
        title: string,
        path: string,
        data: Record<string, string> = {},
      ) => sql`
        insert into nodes (id, owner_id, type, title, path, data, tags)
        values (${nodeId}, ${brain}, ${type}::node_type, ${title}, ${path}::ltree,
                ${sql.json(data)}, '{}')`;
      await node(randomUUID(), 'branch', 'Files', 'files');
      await node(id.folder, 'branch', 'Shared', 'files.shared');
      await sql`update nodes set share_level = 'team' where id = ${id.folder}`;
      await node(id.file, 'file', 'a.txt', 'files.shared', { filename: 'a.txt' });
      await node(id.note, 'note', 'A note', 'notes', { content: 'restore me' });
      await sql`update nodes set embedding = ${vector}::vector where id = ${id.note}`;
      await sql`
        insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
        values (${brain}, ${id.note}, 0, 'restore me', ${vector}::vector)`;
      await node(randomUUID(), 'task', 'Due', 'tasks', {
        status: 'open',
        due_at: '2026-10-02T10:00:00Z',
      });
      await node(randomUUID(), 'event', 'Soon', 'events', {
        starts_at: '2026-10-03T08:00:00Z',
        remind_at: '2026-10-03T07:45:00Z',
      });
      const [file] = await sql`select inherited_level from nodes where id = ${id.file}`;
      expect(file?.inherited_level).toBe('team');
      // The rows reach the expression indexes: the dates are read as dates.
      const [dated] = await sql`
        select count(*)::int as n from nodes
         where type in ('task', 'event') and jsonb_typeof(data) = 'object'
           and mantle_iso_to_ts(coalesce(data->>'due_at', data->>'starts_at')) is not null`;
      expect(dated?.n).toBe(2);
    } finally {
      await sql.end();
    }
  }, 180_000);

  afterAll(async () => {
    for (const t of targets) await t.drop();
    await source?.drop();
  }, 120_000);

  it('restores with no pg_restore error: every trigger, policy, function, constraint, index and row', async () => {
    const { target, errors, log } = await dumpAndRestore();
    expect(errors, log).toEqual([]);
    await expectSameCatalog(target);
    const before = await rowsOf(source!.url);
    expect(before.nodes.length).toBeGreaterThanOrEqual(6);
    expect(before.chunks).toHaveLength(1);
    expect(await rowsOf(target.url)).toEqual(before);
  }, 120_000);

  it('a schema-only dump restores with no pg_restore error too', async () => {
    const { target, errors, log } = await dumpAndRestore(['--schema-only']);
    expect(errors, log).toEqual([]);
    await expectSameCatalog(target);
  }, 120_000);

  it("0204's own trigger (IS DISTINCT FROM on the ltree path) is lost on a restore: the check sees it", async () => {
    // Put the trigger back as 0204 made it. This runs last and on the
    // scratch database only.
    const made = statementsOf('0204_folder_sharing.sql').find((s) =>
      s.includes('CREATE TRIGGER "nodes_share_refresh_after"'),
    );
    expect(made, 'the trigger is no longer made by 0204').toBeTruthy();
    expect(made).toMatch(/OLD\."path" IS DISTINCT FROM NEW\."path"/);
    const sql = postgres(source!.url, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe('DROP TRIGGER "nodes_share_refresh_after" ON "public"."nodes"');
      await sql.unsafe(made!);
    } finally {
      await sql.end();
    }

    const { target, errors, log } = await dumpAndRestore();
    expect(errors, log).toHaveLength(1);
    expect(errors[0]).toMatch(/operator does not exist: public\.ltree = public\.ltree/);
    // scripts/db-restore.sh knows this error by the statement pg_restore
    // prints after it: the line it greps for is what pg_restore writes.
    expect(log.split('\n')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Command was: CREATE TRIGGER nodes_share_refresh_after /),
      ]),
    );
    const grepped = readFileSync(
      join(__dirname, '..', '..', '..', 'scripts', 'db-restore.sh'),
      'utf8',
    );
    expect(grepped).toContain("grep -c '^Command was: CREATE TRIGGER nodes_share_refresh_after '");
    const before = Object.keys((await catalogOf(source!.url)).triggers);
    const after = Object.keys((await catalogOf(target.url)).triggers);
    expect(before).toContain(TRIGGER);
    expect(before.filter((t) => !after.includes(t))).toEqual([TRIGGER]);
  }, 120_000);
});
