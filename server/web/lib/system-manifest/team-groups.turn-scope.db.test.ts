/**
 * Every tool of the Team assistant's groups, run in its turn scope (workspaces
 * W4b) through dispatchTool, as a turn calls it: the workspace role with the
 * scope [Team], each query its own short transaction. None may fail on a
 * missing read rule (permission denied) or lose the scope. The Team
 * assistant's groups (team-read, formulas-eval) and what the run-time cap
 * keeps of team-read-admin (nothing: it is adminOnly) are swept. Also the
 * whole turn's own reads: the context loader and the tool groups it resolves.
 *
 * On a scratch database of its own: the workspaces migration is per brain.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/system-manifest/team-groups.turn-scope.db.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MANIFEST_ADMIN_ONLY_GROUPS, MANIFEST_TOOL_GROUPS } from './manifest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TEAM_GROUPS = ['team-read', 'formulas-eval'];

const h = vi.hoisted(() => ({ vec: [] as number[] }));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => h.vec),
}));
// dispatchTool turns a thrown error into its message; drizzle's message is
// "Failed query: …" and the database's reason is on its cause. The sweep
// needs the reason (permission denied, a lost scope), so it is appended.
vi.mock('@mantle/std', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/std')>();
  return {
    ...actual,
    errorMessage: (err: unknown) => {
      const text = actual.errorMessage(err);
      const cause = (err as { cause?: { message?: string; name?: string } } | null)?.cause;
      return cause?.message ? `${text} [cause ${cause.name ?? ''}: ${cause.message}]` : text;
    },
  };
});

type Row = Record<string, unknown>;

describe.skipIf(!URL)('the Team assistant’s tools in its turn scope', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let sqlTag: typeof import('drizzle-orm').sql;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-team-turn-'));
  const owner = randomUUID();
  const member = randomUUID();
  const ids: Record<string, string> = {};
  let team = '';

  const scope = () => ({
    kind: 'assistant' as const,
    loginId: member,
    ws: [team],
    modWs: [team],
  });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    const x = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
    await x(sqlTag`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${`tt-${owner.slice(0, 8)}@example.invalid`}, 'x', true, 'admin'),
      (${member}, ${`tm-${member.slice(0, 8)}@example.invalid`}, 'x', false, 'member')`);
    await x(sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    // The manifest's groups the Team assistant holds (a scratch brain has no
    // seed): team-read, formulas-eval, and team-read-admin, adminOnly (as the
    // seeder writes them: no level, admin_only from the manifest).
    for (const g of MANIFEST_TOOL_GROUPS.filter((g) =>
      [...TEAM_GROUPS, 'team-read-admin'].includes(g.slug),
    )) {
      await x(sqlTag`insert into tool_groups (owner_id, slug, name, tool_slugs, admin_only)
        values (${owner}, ${g.slug}, ${g.name}, ${`{${g.toolSlugs.join(',')}}`}::text[],
                ${MANIFEST_ADMIN_ONLY_GROUPS.includes(g.slug)})`);
    }
    await x(sqlTag`select * from mantle_ws_migrate()`);
    const [ws] = (await x(
      sqlTag`select id::text as id from workspaces where owner_id = ${owner} and bridge_key = 'team'`,
    )) as unknown as { id: string }[];
    team = ws!.id;

    const c = await import('@mantle/content');
    h.vec = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
    const vec = `[${h.vec.join(',')}]`;
    ids.page = (await c.createPage(owner, { title: 'team page' })).id;
    ids.note = (await c.createNote(owner, { title: 'team note', content: 'team note' })).id;
    const col = randomUUID();
    ids.table = (
      await c.createTable(owner, {
        title: 'team table',
        data: {
          columns: [{ id: col, name: 'Name', type: 'text' }],
          rows: [{ id: randomUUID(), cells: { [col]: 'a row' } }],
        },
      })
    ).id;
    // Team reads them: a grant each, as Grant Access writes it (W5b2).
    const shared = Object.values(ids);
    await m.withHeads(shared, 'update', async (tx) => {
      for (const id of shared) {
        await tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, write)
          values (${id}, ${team}, false)`);
      }
    });
    ids.adminPage = (await c.createPage(owner, { title: 'admin page' })).id;
    await x(sqlTag`update nodes set embedding = ${vec}::vector
      where owner_id = ${owner} and type in ('page', 'note', 'table')`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('no tool fails on a read rule or a lost scope', async () => {
    const { BUILTIN_TOOLS, dispatchTool } = await import('@mantle/tools');
    const none = '00000000-0000-4000-8000-000000000000';
    const page = ids.page ?? none;
    const table = ids.table ?? none;
    const inputs: Record<string, Row> = {
      search_nodes: { q: 'team' },
      search_chunks: { q: 'team' },
      read_section: { node_id: page },
      node_read: { node_id: page },
      folder_get_by_path: { path: 'files' },
      file_list: { parent_path: 'files' },
      file_get: { file_id: none },
      file_read: { file_id: none },
      show_image: { file_id: none },
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
      app_db_query: { app_id: none, sql: 'select 1' },
      summarize_text: { node_id: page },
      read_result: { handle: 'x' },
      formula_get: { id: none },
      formula_evaluate: { id: none, target: 'x' },
    };
    const slugs = MANIFEST_TOOL_GROUPS.filter((g) => TEAM_GROUPS.includes(g.slug)).flatMap(
      (g) => g.toolSlugs,
    );
    const bad: string[] = [];
    const report: string[] = [];
    for (const slug of slugs) {
      // Writes on the member's behalf leave the scope (asSystem): the team
      // turn tests cover them.
      if (slug === 'team_request_create') continue;
      const def = BUILTIN_TOOLS.find((t) => t.slug === slug);
      if (!def) continue;
      // Through dispatchTool, as a turn calls it: the ownerOnly and adminOnly
      // gates, the preconditions and the handler, in the turn scope.
      const row = {
        slug,
        name: def.name,
        description: def.description,
        handler: { kind: 'builtin', ref: slug },
        inputSchema: def.inputSchema,
        requiresConfirm: false,
      } as unknown as import('@mantle/db').Tool;
      let outcome: string;
      try {
        const res = await m.withTurnScope(scope(), () =>
          dispatchTool(row, inputs[slug] ?? {}, {
            ownerId: owner,
            surface: { kind: 'team', loginId: member, privateReads: false },
          }),
        );
        outcome = res.ok ? 'ok' : `error: ${res.error}`;
      } catch (err) {
        const cause = (err as { cause?: { message?: string } }).cause?.message ?? '';
        outcome = `threw: ${(err as Error).name} ${cause || (err as Error).message}`;
      }
      // A missing read rule, a lost scope, a refused
      // scope change, an unscoped hand-off, an unnamed exit to the system
      // pool: each is a tool that does not work in the Team turn.
      if (
        /permission denied|outside its turn scope|AgentWorkspaceError|another workspace|already inside another scope|would run unscoped|must carry that scope|allowlisted reason|ScopeLostError|TurnScopeExitError/i.test(
          outcome,
        )
      ) {
        bad.push(`${slug}: ${outcome.slice(0, 160)}`);
      }
      report.push(`${slug}: ${outcome.slice(0, 110)}`);
    }
    console.log('[team-turn-tools]\n' + report.join('\n'));
    expect(bad, 'tools that fail in the Team turn scope').toEqual([]);
  });

  it('search finds the team page and never the admin page', async () => {
    const { BUILTIN_TOOLS } = await import('@mantle/tools');
    const search = BUILTIN_TOOLS.find((t) => t.slug === 'search_nodes')!;
    const res = await m.withTurnScope(scope(), () =>
      search.handler(
        { q: 'page' },
        { ownerId: owner, surface: { kind: 'team', loginId: member, privateReads: false } },
      ),
    );
    const text = JSON.stringify(res);
    expect(res.ok).toBe(true);
    expect(text).not.toContain(ids.adminPage);
  });

  it('the turn’s own reads: tool groups (no adminOnly) and the context loader', async () => {
    const rt = await import('@mantle/runtime/agent');
    const tools = await m.withTurnScope(scope(), () =>
      rt.resolveAgentToolGroups(owner, ['team-read', 'formulas-eval', 'team-read-admin']),
    );
    expect(tools).toContain('search_nodes');
    expect(tools).not.toContain('email_list');
    expect(tools).not.toContain('entity_search');
  });

  it('withAgentScope: the Team assistant in [Team], the Admin one in [Admin], helpers inside', async () => {
    const rt = await import('@mantle/runtime/agent');
    const x = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
    const [adminWs] = (await x(
      sqlTag`select id::text as id from workspaces where owner_id = ${owner} and bridge_key = 'admin'`,
    )) as unknown as { id: string }[];
    const teamAgent = { workspaceId: team };
    const persona = { workspaceId: adminWs!.id };
    const helper = { workspaceId: null };
    // The member moderates Team (the login bridge): modWs is Team.
    const seen = await rt.withAgentScope(teamAgent, async () => m.currentScope(), {
      loginId: member,
    });
    expect(seen).toMatchObject({ kind: 'assistant', loginId: member, ws: [team], modWs: [team] });
    // No login: read only.
    const anon = await rt.withAgentScope(teamAgent, async () => m.currentScope());
    expect(anon).toMatchObject({ kind: 'assistant', loginId: null, modWs: [] });
    // The Admin assistant (W7a): a turn scope of Admin, with its stamp.
    const admin = await rt.withAgentScope(
      persona,
      async () => ({ scope: m.currentScope(), stamp: m.currentTurnStamp() }),
      { loginId: owner },
    );
    expect(admin).toMatchObject({
      scope: { kind: 'assistant', loginId: owner, ws: [adminWs!.id] },
      stamp: { workspaceId: adminWs!.id, loginId: owner },
    });
    // The rollback switch: the system pool, with its stamp, as before W7a.
    process.env.MANTLE_ADMIN_READS = 'system';
    try {
      const sys = await rt.withAgentScope(
        persona,
        async () => ({ scope: m.currentScope(), stamp: m.currentTurnStamp() }),
        { loginId: owner },
      );
      expect(sys).toEqual({
        scope: { kind: 'system' },
        stamp: { workspaceId: adminWs!.id, loginId: owner },
      });
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
    }
    // Inside the Team turn: a helper keeps the scope; the Admin assistant is refused.
    await rt.withAgentScope(
      teamAgent,
      async () => {
        const inner = await rt.withAgentScope(helper, async () => m.currentScope());
        expect(inner).toMatchObject({ ws: [team] });
        await expect(rt.withAgentScope(persona, async () => 1)).rejects.toThrow(
          /another workspace/,
        );
      },
      { loginId: member },
    );
  });
});
