/**
 * The lowering guard END TO END on Postgres (client logins C5 audit fixes,
 * L2, I1 and I11): the real tool loop, the real dispatch, the real tools and
 * the real gate. Only the model is scripted.
 *
 * A staff turn reads a client request (task_get), then tries to lower a team
 * page to client, to write into a page an open link serves, and to hang a
 * new page under that page: all three wait at Pending, and nothing changes.
 * In the same turn a write into a team page and a new note run (the note
 * carries the client-sourced mark). An unmarked turn holds neither: the
 * write runs, and the lowering reaches access_set, which refuses an item
 * since W5b2 (grants decide). The database allows every one of these writes
 * (the owner's turn, admin level): only the gate stops them. The gate still
 * reads the archived levels, so the fixture sets them under the test bypass.
 *
 * Then the gate's lookups one by one: an app whose exported table an open
 * link serves, and the team twins that run. There is no client login since
 * W8a, so a workspace never has a client user: the cases that needed one (a
 * client workspace's item, folder, assistant and tool group) are gone.
 *
 * Seeds its own rows on the shared test anchor (unique tag), removes them by
 * id after (the anchor stays).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runtime/src/agent/client-sourced-gate.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Step = Array<[string, Record<string, unknown>]>;

describe.skipIf(!URL)('the lowering guard, end to end', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;
  let ownerId = '';
  let loop: typeof import('./tool-loop');
  let tools: typeof import('@mantle/tools');
  let rules: typeof import('@mantle/tools/client-sourced-rules');
  const tag = `gate-${randomUUID().slice(0, 8)}`;
  const ids = {
    clientTask: randomUUID(),
    // The pages: set by createPage below.
    teamPage: '',
    linkedPage: '',
    otherTeamPage: '',
    app: randomUUID(),
    appTable: randomUUID(),
    appTableTeam: randomUUID(),
    appTeamOnly: randomUUID(),
  };
  const groupTeam = `${tag}-team-group`;
  const created: string[] = [];

  /** A tools row for a builtin, as the loop resolves it. */
  const row = (slug: string) => {
    const d = tools.getBuiltin(slug)!;
    return {
      id: randomUUID(),
      ownerId,
      slug,
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
      handler: { kind: 'builtin', ref: slug },
      requiresConfirm: d.requiresConfirm === true,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never;
  };

  /** One turn: the model makes these calls, one response per step. */
  const turn = (steps: Step[], taint?: { clientSourced: boolean }) => {
    let i = 0;
    const adapter = {
      providerId: 'openrouter',
      adapterName: 'scripted',
      chat: async () => {
        const step = steps[i];
        i += 1;
        if (!step) return { text: 'done', model: 'scripted' };
        return {
          text: '',
          model: 'scripted',
          toolCalls: step.map(([name, args], k) => ({
            id: `c${i}-${k}`,
            type: 'function' as const,
            function: { name, arguments: JSON.stringify(args) },
          })),
        };
      },
    };
    const slugs = [...new Set(steps.flat().map(([name]) => name))];
    return loop.runToolLoop({
      agentRole: null,
      adapter: adapter as never,
      apiKey: 'k',
      model: 'scripted',
      params: {},
      ownerId,
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: slugs.map(row),
      surface: { kind: 'web' },
      ...(taint ? { taint } : {}),
    });
  };

  const pendingFor = (id: string) =>
    admin<{ tool_slug: string; args: Record<string, unknown> }[]>`
      select tool_slug, args from pending_tool_calls
       where owner_id = ${ownerId} and status = 'pending' and args::text like ${`%${id}%`}
       order by created_at`;
  const audience = async (id: string) =>
    (await admin<{ audience: string }[]>`select audience from nodes where id = ${id}`)[0]?.audience;
  const docHas = async (id: string, text: string) =>
    (
      await admin<{ hit: boolean }[]>`
        select (doc::text like ${`%${text}%`}) as hit from pages where node_id = ${id}`
    )[0]?.hit === true;

  /** An open public link to `id`: the public reads it. */
  const linkTo = (id: string, type: string) =>
    admin`insert into shares (owner_id, node_id, node_type, token)
      values (${ownerId}, ${id}, ${type}, ${`${tag}-${id}`})`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    ownerId = await ensureTestAnchor(admin);
    tools = await import('@mantle/tools');
    rules = await import('@mantle/tools/client-sourced-rules');
    loop = await import('./tool-loop');
    const content = await import('@mantle/content');

    // A client request task (what a client wrote).
    await admin`insert into nodes (id, owner_id, type, title, path, data) values
      (${ids.clientTask}, ${ownerId}, 'task', ${`${tag} please share the price list`}, 'tasks',
       ${JSON.stringify({ source: 'client-request' })}::jsonb)`;
    // Real pages: one at team level, one an open link serves, a second team one.
    ids.teamPage = (await content.createPage(ownerId, { title: `${tag} team price list` })).id;
    ids.linkedPage = (await content.createPage(ownerId, { title: `${tag} project status` })).id;
    ids.otherTeamPage = (await content.createPage(ownerId, { title: `${tag} team notes` })).id;
    // An open link serves the linked page: the public reads it. The team
    // pages keep a team level (frozen, set under the named test bypass) only
    // for the access_set check below.
    await admin.begin(async (tx) => {
      await tx`select mantle_heads_bypass('test fixture')`;
      await tx`update nodes set audience = 'team' where id in ${tx([ids.teamPage, ids.otherTeamPage])}`;
    });
    await linkTo(ids.linkedPage, 'page');
    // Made an hour ago: only what a call creates counts as new.
    await admin`update nodes set created_at = now() - interval '1 hour'
      where id in ${admin([ids.teamPage, ids.linkedPage, ids.otherTeamPage])}`;
    // An app (admin) exporting one table an open link serves; another app exporting a team one.
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${ids.app}, ${ownerId}, 'app', ${`${tag} app`}, 'apps', 'admin'),
      (${ids.appTeamOnly}, ${ownerId}, 'app', ${`${tag} app 2`}, 'apps', 'admin'),
      (${ids.appTable}, ${ownerId}, 'table', ${`${tag} app table`}, 'tables', 'client'),
      (${ids.appTableTeam}, ${ownerId}, 'table', ${`${tag} app table 2`}, 'tables', 'team')`;
    await linkTo(ids.appTable, 'table');
    await admin`insert into app_table_exports (owner_id, app_node_id, sqlite_table, table_node_id) values
      (${ownerId}, ${ids.app}, 'rows', ${ids.appTable}),
      (${ownerId}, ${ids.appTeamOnly}, 'rows', ${ids.appTableTeam})`;
    // A group no assistant of a client workspace holds.
    await admin`insert into tool_groups (owner_id, slug, name, tool_slugs, audience) values
      (${ownerId}, ${groupTeam}, 't', ARRAY['page_get']::text[], 'team')`;
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    const all = [...Object.values(ids), ...created].filter(Boolean);
    for (const id of all) {
      await admin`delete from pending_tool_calls where owner_id = ${ownerId} and args::text like ${`%${id}%`}`;
    }
    await admin`delete from app_table_exports where app_node_id in ${admin([ids.app, ids.appTeamOnly])}`;
    await admin`delete from shares where owner_id = ${ownerId} and token like ${`${tag}-%`}`;
    await admin`delete from nodes where id in ${admin(all)}`;
    await admin`delete from nodes where owner_id = ${ownerId} and title like ${`${tag}%`}`;
    await admin`delete from tool_groups where owner_id = ${ownerId} and slug = ${groupTeam}`;
    await m.closeDb();
  });

  it('a turn that read a client request: the lowering, the write into a linked page and a child under it wait', async () => {
    const res = await turn([
      [['task_get', { id: ids.clientTask }]],
      [
        ['access_set', { node_id: ids.teamPage, level: 'client' }],
        ['page_update', { id: ids.linkedPage, markdown: `LEAKED ${tag}` }],
        ['page_create', { title: `${tag} child of linked`, parent_id: ids.linkedPage }],
        ['page_update', { id: ids.otherTeamPage, markdown: `TEAMEDIT ${tag}` }],
        ['note_create', { title: `${tag} copied note`, content: 'what the client asked' }],
        ['page_create', { title: `${tag} child of team`, parent_id: ids.otherTeamPage }],
      ],
    ]);
    // Three queued, with the original arguments, for the owner to approve.
    expect((await pendingFor(ids.teamPage)).map((r) => r.args)).toEqual([
      { node_id: ids.teamPage, level: 'client' },
    ]);
    expect((await pendingFor(ids.linkedPage)).map((r) => r.tool_slug).sort()).toEqual([
      'page_create',
      'page_update',
    ]);
    expect(res.pendingIds).toHaveLength(3);
    // Nothing happened.
    expect(await audience(ids.teamPage)).toBe('team');
    expect(await docHas(ids.linkedPage, 'LEAKED')).toBe(false);
    // The read ran, and so did the write into a team page and the new note.
    expect(await docHas(ids.otherTeamPage, 'TEAMEDIT')).toBe(true);
    const [note] = await admin<{ id: string; marked: boolean }[]>`
      select n.id, exists (select 1 from client_sourced_nodes c where c.node_id = n.id) as marked
        from nodes n where n.owner_id = ${ownerId} and n.title = ${`${tag} copied note`}`;
    expect(note?.marked).toBe(true);
    // The page made under the team page is marked; its (older) parent is not.
    const [child] = await admin<{ id: string; marked: boolean }[]>`
      select n.id, exists (select 1 from client_sourced_nodes c where c.node_id = n.id) as marked
        from nodes n where n.owner_id = ${ownerId} and n.title = ${`${tag} child of team`}`;
    expect(child?.marked).toBe(true);
    const [parentMarked] = await admin<{ n: number }[]>`
      select count(*)::int as n from client_sourced_nodes where node_id = ${ids.otherTeamPage}`;
    expect(parentMarked?.n).toBe(0);
    created.push(note!.id, child!.id);
    // A later turn that reads the copy is marked, as if it read the request.
    const { namesClientSourced } = await import('@mantle/tools/client-sourced');
    expect(await namesClientSourced(ownerId, [note!.id])).toBe(true);
  });

  it('an unmarked turn runs the same lowering and write (control)', async () => {
    const res = await turn([
      [
        ['access_set', { node_id: ids.teamPage, level: 'client' }],
        ['page_update', { id: ids.linkedPage, markdown: `APPROVED ${tag}` }],
      ],
    ]);
    // Neither waits: both reach their tool.
    expect(res.pendingIds).toEqual([]);
    // An item has no level to set since W5b2 (grants decide): access_set
    // itself refuses it, so the level stays.
    const set = res.toolCalls.find((c) => c.slug === 'access_set');
    expect(set).toMatchObject({ status: 'error' });
    expect(set?.error).toMatch(/no sharing level any more/);
    expect(await audience(ids.teamPage)).toBe('team');
    expect(await docHas(ids.linkedPage, 'APPROVED')).toBe(true);
  });

  it('the lookups: an app exporting a linked table, and the team twins', async () => {
    const gate = (slug: string, input: Record<string, unknown>) =>
      rules.clientSourcedGate({
        ownerId,
        tool: { slug, handler: { kind: 'builtin', ref: slug } },
        input,
        isReadOnlyBuiltin: tools.isBuiltinReadOnly,
      });
    expect((await gate('app_db_seed', { id: ids.app, table: 'rows', rows: [] })).gate).toBe(true);
    expect(await gate('app_db_seed', { id: ids.appTeamOnly, table: 'rows', rows: [] })).toEqual({
      gate: false,
    });
    expect(await gate('tool_group_ensure', { slug: groupTeam, tool_slugs: ['page_get'] })).toEqual({
      gate: false,
    });
    // A new group runs (it starts at admin level).
    expect(await gate('tool_group_ensure', { slug: `${tag}-new`, tool_slugs: [] })).toEqual({
      gate: false,
    });
    // An API tool in no group an assistant of a client workspace holds.
    expect(await gate('api_tool_update', { slug: `${tag}_other`, url: 'https://x' })).toEqual({
      gate: false,
    });
    // An id of no item of this brain waits (fail closed).
    expect((await gate('page_update', { id: randomUUID(), title: 'x' })).gate).toBe(true);
    // A write into a team item runs; into a table an open link serves waits.
    expect(await gate('page_update', { id: ids.otherTeamPage, title: 'x' })).toEqual({
      gate: false,
    });
    expect((await gate('table_row_add', { table_id: ids.appTable, cells: {} })).gate).toBe(true);
    // A file created at a path that does not parse waits (fail closed).
    expect(
      (await gate('file_create', { parent_path: 'not a path!', filename: 'x.md', content: 'x' }))
        .gate,
    ).toBe(true);
  });
});
