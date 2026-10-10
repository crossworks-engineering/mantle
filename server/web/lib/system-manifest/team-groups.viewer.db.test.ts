/**
 * Every tool in a TEAM-level manifest group, run where a Team assistant runs
 * it: a Team turn scope on the workspace role (member logins Phase 0b,
 * workspaces W5b2). A team-level group may only hold tools that work there:
 * they return what Team holds or nothing, and never fail on a table or
 * column the workspace role may not read.
 *
 * On a scratch brain the workspaces migration made live, with a member of
 * Team and one item of each kind the tools read (a page, a table, a note, a
 * file and a folder), each held by Team by a grant.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/system-manifest/team-groups.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MANIFEST_TOOL_GROUPS } from './manifest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
/** The groups the manifest ships at team level (manifest.test.ts pins which). */
const TEAM_LEVEL_GROUPS = MANIFEST_TOOL_GROUPS.filter((g) => g.level === 'team').map((g) => g.slug);

const h = vi.hoisted(() => ({ vec: [] as number[] }));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => h.vec),
}));

type Row = Record<string, unknown>;

describe.skipIf(!URL)('team-level tool groups in a Team turn scope', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  const ownerId = randomUUID();
  const member = randomUUID();
  let team = '';
  const ids: Record<string, string> = {};
  const tag = `team-groups-${randomUUID().slice(0, 8)}`;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-team-groups-'));

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key'; // shared: roles are cluster-wide
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    const c = await import('@mantle/content');
    const email = (who: string) => `tg-${who}-${ownerId.slice(0, 8)}@example.invalid`;
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${ownerId}, ${email('owner')}, 'x', true, 'admin'),
      (${member}, ${email('member')}, 'x', false, 'member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${ownerId}, 'brain', ${ownerId})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    team = (
      await x<{ id: string }>(sql`select id::text as id from workspaces
        where owner_id = ${ownerId} and bridge_key = 'team'`)
    )[0]!.id;
    h.vec = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
    const vec = `[${h.vec.join(',')}]`;

    // One of each workspace kind the tools read (homed in Admin as new).
    ids.page = (await c.createPage(ownerId, { title: `${tag} page` })).id;
    ids.note = (await c.createNote(ownerId, { title: `${tag} note`, content: 'team note' })).id;
    const col = randomUUID();
    ids.table = (
      await c.createTable(ownerId, {
        title: `${tag} table`,
        data: {
          columns: [{ id: col, name: 'Name', type: 'text' }],
          rows: [{ id: randomUUID(), cells: { [col]: 'a row' } }],
        },
      })
    ).id;
    ids.branch = randomUUID();
    ids.file = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path) values
      (${ids.branch}, ${ownerId}, 'branch', ${`${tag} folder`},
       ${`files.tg_${ids.branch.replace(/-/g, '')}`}::ltree)`);
    await x(sql`insert into nodes (id, owner_id, type, title, path, data) values
      (${ids.file}, ${ownerId}, 'file', ${`${tag} file.txt`}, 'files',
       ${JSON.stringify({ filename: `${tag}.txt`, mime_type: 'text/plain' })}::jsonb)`);
    // Team holds every one of them (W5b2: a grant, not a level).
    const all = Object.values(ids);
    for (const id of all) {
      await m.withSubtreeHeads(id, [], async (tx) => {
        await tx.execute(
          sql`insert into item_grants (node_id, workspace_id) values (${id}, ${team})`,
        );
      });
    }
    await m.withHeads(all, 'update', async (tx) => {
      await tx.execute(sql`update nodes set embedding = ${vec}::vector
        where id in (${sql.join(
          all.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`);
    });
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  it('no tool in a team-level group fails on a permission error', async () => {
    const { BUILTIN_TOOLS } = await import('@mantle/tools');
    const none = '00000000-0000-4000-8000-000000000000';
    const page = ids.page ?? none;
    const table = ids.table ?? none;
    const file = ids.file ?? none;
    const inputs: Record<string, Row> = {
      search_nodes: { q: 'brain' },
      search_chunks: { q: 'brain' },
      read_section: { node_id: page },
      node_read: { node_id: page },
      folder_get_by_path: { path: 'files' },
      file_list: { parent_path: 'files' },
      file_get: { file_id: file },
      file_read: { file_id: file },
      folder_describe: { folder_id: ids.branch ?? none, description: 'x' },
      show_image: { file_id: file },
      note_get: { id: ids.note ?? none },
      page_get: { id: page },
      page_blocks_list: { page_id: page },
      page_block_get: { page_id: page, block_id: 'x' },
      table_get: { id: table },
      table_schema: { table_ids: [table] },
      table_query: { table_id: table },
      table_sql: { table_id: table, sql: 'select 1' },
      table_rows_list: { table_id: table },
      table_row_get: { table_id: table, row_id: '1' },
      table_aggregate: { table_id: table, group_by: 'x' },
      app_db_query: { app_id: ids.app ?? none, sql: 'select 1' },
      summarize_text: { node_id: page },
      read_result: { handle: 'x' },
      formula_get: { id: none },
      formula_evaluate: { id: none, target: 'x' },
    };
    const slugs = MANIFEST_TOOL_GROUPS.filter((g) => TEAM_LEVEL_GROUPS.includes(g.slug)).flatMap(
      (g) => g.toolSlugs,
    );
    const denied: string[] = [];
    const report: string[] = [];
    for (const slug of slugs) {
      // Writes on the member's behalf: covered by the team-turn e2e.
      if (slug === 'team_request_create') continue;
      const tool = BUILTIN_TOOLS.find((t) => t.slug === slug);
      if (!tool) continue;
      let outcome: string;
      try {
        const res = await m.withTurnScope(
          { kind: 'assistant', loginId: member, ws: [team], modWs: [] },
          () =>
            tool.handler(inputs[slug] ?? {}, {
              ownerId,
              surface: { kind: 'team', loginId: member, privateReads: false },
            }),
        );
        outcome = res.ok ? 'ok' : `error: ${res.error}`;
      } catch (err) {
        const cause = (err as { cause?: { message?: string } }).cause?.message ?? '';
        outcome = `threw: ${cause || (err as Error).message}`;
      }
      if (/permission denied/i.test(outcome)) denied.push(`${slug}: ${outcome.slice(0, 160)}`);
      report.push(`${slug}: ${outcome.slice(0, 110)}`);
    }
    console.log('[team-tools]\n' + report.join('\n'));
    expect(denied, 'tools in a team-level group that fail in a Team turn').toEqual([]);
  });
});
