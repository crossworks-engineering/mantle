/**
 * Every tool in a TEAM-level manifest group, run on the team viewer role
 * (member logins Phase 0b). A team-level group may only hold tools that work
 * at team level: they return team items or nothing, and never fail on a table
 * or column the team role may not read. Needs a migrated copy of a
 * provisioned brain:
 *   MANTLE_TEST_BRAIN_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/system-manifest/team-groups.viewer.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MANIFEST_TOOL_GROUPS } from './manifest';

const URL = process.env.MANTLE_TEST_BRAIN_DATABASE_URL;
/** The groups migration 0159 sets to team level. */
const TEAM_LEVEL_GROUPS = ['team-read', 'formulas-eval'];

const h = vi.hoisted(() => ({ vec: [] as number[] }));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => h.vec),
}));

type Row = Record<string, unknown>;

describe.skipIf(!URL)('team-level tool groups on the team viewer role', () => {
  let m: typeof import('@mantle/db');
  let admin: Parameters<typeof m.ensureViewerRoles>[0];
  let ownerId = '';
  const ids: Record<string, string> = {};
  const lowered: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key'; // shared: roles are cluster-wide
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    const [o] = await admin<Row[]>`select id from auth.users where is_owner`;
    ownerId = o!.id as string;
    // One of each workspace kind at team level (restored after).
    for (const type of ['page', 'table', 'note', 'file', 'branch', 'app', 'draw']) {
      const [r] = await admin<Row[]>`
        select id, audience from nodes where owner_id = ${ownerId} and type = ${type}
        order by (audience <> 'admin') desc, updated_at desc limit 1`;
      if (!r) continue;
      ids[type] = r.id as string;
      if (r.audience === 'admin') {
        await admin`update nodes set audience = 'team' where id = ${r.id as string}`;
        lowered.push(r.id as string);
      }
    }
    const [v] = await admin<Row[]>`
      select embedding::text as v from content_chunks where embedding is not null limit 1`;
    h.vec = JSON.parse(v!.v as string) as number[];
  });

  afterAll(async () => {
    for (const id of lowered) await admin`update nodes set audience = 'admin' where id = ${id}`;
    await m?.closeDb();
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
        const res = await m.withViewer('team', () =>
          tool.handler(inputs[slug] ?? {}, {
            ownerId,
            surface: { kind: 'team', contactId: 'c', privateReads: false },
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
    expect(denied, 'tools in a team-level group that fail at team level').toEqual([]);
  });
});
