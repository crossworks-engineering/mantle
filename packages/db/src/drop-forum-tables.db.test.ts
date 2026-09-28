/**
 * Migration 0177 (member logins Phase 6) on a real, migrated Postgres: the
 * retired forum's four tables are dropped and nothing else is touched.
 *
 * The migrated database already ran 0177, so the test first proves the tables
 * are gone, then puts them back from their own migrations (0123, 0124, 0126:
 * all IF NOT EXISTS), seeds forum rows next to the rows that must survive (a
 * Forum archive page, a file the export filed, an app with its node, a
 * sandbox, a team chat message) and runs 0177's statements
 * again. It proves: a topic with no archive page aborts the drop; an
 * unexpected dependency (a view) fails it instead of being dropped with the
 * table (no CASCADE); the tables go and every other row stays, with the same
 * counts; a second run is a no-op.
 *
 * It runs on a scratch database of its own (migrated from scratch, dropped
 * after), never the shared test database: its DROP CONSTRAINT locks nodes
 * and deadlocked with other test files deleting nodes.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/drop-forum-tables.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const MIGRATIONS = join(__dirname, '..', 'migrations');
const FORUM_TABLES = ['forum_topics', 'forum_posts', 'forum_uploads', 'forum_read_cursors'];

const statementsOf = (file: string) =>
  readFileSync(join(MIGRATIONS, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);

type Row = Record<string, unknown>;

describe.skipIf(!URL)('migration 0177: drop the forum tables', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let goneAfterMigrate: string[] = [];
  const owner = randomUUID();
  const tag = `drop-forum-${owner.slice(0, 8)}`;
  const id = {
    contact: randomUUID(),
    archiveIndex: randomUUID(),
    archiveTopic: randomUUID(),
    filedFile: randomUUID(),
    dumpFile: randomUUID(),
    appNode: randomUUID(),
    sandbox: randomUUID(),
    teamMessage: randomUUID(),
    topic: randomUUID(),
    post: randomUUID(),
    upload: randomUUID(),
  };

  const drop = statementsOf('0177_drop_forum_tables.sql');
  const runDrop = async (tx: postgres.Sql | postgres.TransactionSql = sql) => {
    for (const stmt of drop) await tx.unsafe(stmt);
  };
  const forumTablesPresent = async () =>
    (
      await sql<{ t: string }[]>`
        select relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = any(${FORUM_TABLES}) order by 1`
    ).map((r) => r.t);
  /** Every count the drop must leave alone, for the seeded owner. */
  const counts = async () => {
    const [r] = await sql<Row[]>`
      select (select count(*) from nodes where owner_id = ${owner})::int as owner_nodes,
             (select count(*) from nodes where owner_id = ${owner} and type = 'app')::int as app_nodes,
             (select count(*) from nodes where owner_id = ${owner}
                and data->>'source' = 'forum-archive')::int as archive_pages,
             (select count(*) from nodes where type = 'file' and owner_id = ${owner})::int as files,
             (select count(*) from apps a join nodes n on n.id = a.node_id
               where n.owner_id = ${owner})::int as apps,
             (select count(*) from sandboxes where owner_id = ${owner})::int as sandboxes,
             (select count(*) from team_messages where owner_id = ${owner})::int as team_messages`;
    return r!;
  };

  beforeAll(async () => {
    // A database of this test's own, migrated from scratch: rebuilding and
    // dropping tables that reference nodes (ADD / DROP CONSTRAINT) locks
    // nodes, which deadlocks with any other test file deleting nodes on the
    // shared database (opposite lock order). Here nothing else runs.
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 1, onnotice: () => {} });
    goneAfterMigrate = await forumTablesPresent();
    // The tables as the forum had them.
    for (const file of [
      '0123_team_forum.sql',
      '0124_forum_post_workflow_id.sql',
      '0126_forum_uploads.sql',
    ]) {
      for (const stmt of statementsOf(file)) await sql.unsafe(stmt);
    }

    await sql`insert into auth.users (id, email, password_hash, role)
              values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`;
    await sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    const archive = (kind: string) =>
      JSON.stringify({ source: 'forum-archive', forumArchive: { kind } });
    await sql`insert into nodes (id, owner_id, type, title, path, data) values
      (${id.contact}, ${owner}, 'contact', 'A member', 'contacts', '{}'::jsonb),
      (${id.archiveIndex}, ${owner}, 'page', 'Forum archive', 'pages', ${archive('index')}::text::jsonb),
      (${id.archiveTopic}, ${owner}, 'page', 'A topic', 'pages', ${archive('topic')}::text::jsonb),
      (${id.filedFile}, ${owner}, 'file', 'jam.txt', 'files.review.forum_archive', '{}'::jsonb),
      (${id.dumpFile}, ${owner}, 'file', 'forum.json', 'files.archive', '{}'::jsonb),
      (${id.appNode}, ${owner}, 'app', 'An app', 'apps', '{}'::jsonb)`;
    await sql`insert into apps (node_id) values (${id.appNode})`;
    await sql`insert into sandboxes (id, owner_id, name, image)
              values (${id.sandbox}, ${owner}, ${tag}, 'alpine')`;
    await sql`insert into team_messages (id, owner_id, contact_id, direction, text)
              values (${id.teamMessage}, ${owner}, ${id.contact}, 'inbound', 'hello')`;

    // The forum, exported: its topic points at its archive page, the upload
    // at the file the export filed.
    await sql`insert into forum_topics (id, owner_id, title, created_by_contact_id, author_name, node_id)
              values (${id.topic}, ${owner}, 'A topic', ${id.contact}, 'A member', ${id.archiveTopic})`;
    await sql`insert into forum_posts (id, owner_id, topic_id, author_kind, contact_id, author_name, body)
              values (${id.post}, ${owner}, ${id.topic}, 'member', ${id.contact}, 'A member', 'paper jam')`;
    await sql`insert into forum_uploads (id, owner_id, topic_id, post_id, contact_id, filename, mime, size_bytes, status, node_id)
              values (${id.upload}, ${owner}, ${id.topic}, ${id.post}, ${id.contact}, 'jam.txt',
                      'text/plain', 10, 'filed', ${id.filedFile})`;
    await sql`insert into forum_read_cursors (owner_id, reader_id, topic_id)
              values (${owner}, ${id.contact}, ${id.topic})`;
  }, 180_000);

  afterAll(async () => {
    // The whole scratch database goes, whatever a failed test left in it.
    await sql?.end();
    await scratch?.drop();
  });

  it('the migrated database has no forum table', () => {
    expect(goneAfterMigrate).toEqual([]);
  });

  it('refuses to drop a topic that has no archive page', async () => {
    const unexported = randomUUID();
    await sql`insert into forum_topics (id, owner_id, title, author_name)
              values (${unexported}, ${owner}, 'never exported', 'A member')`;
    await expect(sql.begin((tx) => runDrop(tx))).rejects.toThrow(/no Forum archive page/);
    expect(await forumTablesPresent()).toEqual([...FORUM_TABLES].sort());
    await sql`delete from forum_topics where id = ${unexported}`;
  });

  it('fails on a dependency it does not know about instead of dropping it (no CASCADE)', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(`create view forum_probe_v as select id from forum_posts`);
        await runDrop(tx);
      }),
    ).rejects.toThrow(/depend/);
    // Rolled back: the tables and nothing else are as they were.
    expect(await forumTablesPresent()).toEqual([...FORUM_TABLES].sort());
    const [v] = await sql`select to_regclass('public.forum_probe_v') as v`;
    expect(v!.v).toBeNull();
  });

  it('drops the four tables and leaves every other row, with the same counts', async () => {
    const before = await counts();
    expect(before.owner_nodes).toBe(6);
    expect(before.archive_pages).toBeGreaterThanOrEqual(2);
    expect(before.apps).toBeGreaterThanOrEqual(1);
    expect(before.sandboxes).toBeGreaterThanOrEqual(1);
    await runDrop();

    expect(await forumTablesPresent()).toEqual([]);
    const leftovers = await sql`
      select relname from pg_class where relname like 'forum\\_%'
      union all
      select conname from pg_constraint where conname like 'forum\\_%'`;
    expect(leftovers).toEqual([]);

    expect(await counts()).toEqual(before);
    const survivors = await sql<{ id: string; data: Row | null }[]>`
      select id, data from nodes where owner_id = ${owner} order by id`;
    expect(survivors.map((r) => r.id).sort()).toEqual(
      [id.contact, id.archiveIndex, id.archiveTopic, id.filedFile, id.dumpFile, id.appNode].sort(),
    );
    const page = survivors.find((r) => r.id === id.archiveTopic)!;
    expect(page.data).toEqual({ source: 'forum-archive', forumArchive: { kind: 'topic' } });
    expect(await sql`select 1 from apps where node_id = ${id.appNode}`).toHaveLength(1);
    expect(await sql`select 1 from sandboxes where id = ${id.sandbox}`).toHaveLength(1);
    expect(await sql`select 1 from team_messages where id = ${id.teamMessage}`).toHaveLength(1);
  });

  it('a second run is a no-op', async () => {
    const before = await counts();
    await expect(runDrop()).resolves.toBeUndefined();
    expect(await forumTablesPresent()).toEqual([]);
    expect(await counts()).toEqual(before);
  });
});
