/**
 * The lowering guard END TO END on Postgres (client logins C5 audit fixes,
 * L2, I1 and I11): the real tool loop, the real dispatch, the real tools and
 * the real gate. Only the model is scripted.
 *
 * A staff turn reads a client request (task_get), then tries to lower a team
 * page to client, to write into a client-level page, and to hang a new page
 * under the client-level page: all three wait at Pending, and nothing
 * changes. In the same turn a write into a team page and a new note run (the
 * note carries the client-sourced mark). An unmarked turn runs the lowering
 * and the write. The database allows every one of these writes (the owner's
 * turn, admin level): only the gate stops them.
 *
 * Then the gate's lookups one by one: an app whose exported table is at
 * client level, a tool group at client level, an agent at client level.
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
    clientPage: '',
    otherTeamPage: '',
    app: randomUUID(),
    appTable: randomUUID(),
    appTableTeam: randomUUID(),
    appTeamOnly: randomUUID(),
  };
  const groupClient = `${tag}-client-group`;
  const groupTeam = `${tag}-team-group`;
  const agentClient = `${tag}-client-agent`;
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
    // Real pages: one at team level, one at client level, a second team one.
    ids.teamPage = (await content.createPage(ownerId, { title: `${tag} team price list` })).id;
    ids.clientPage = (await content.createPage(ownerId, { title: `${tag} project status` })).id;
    ids.otherTeamPage = (await content.createPage(ownerId, { title: `${tag} team notes` })).id;
    await admin`update nodes set audience = 'team' where id in ${admin([ids.teamPage, ids.otherTeamPage])}`;
    await admin`update nodes set audience = 'client' where id = ${ids.clientPage}`;
    // Made an hour ago: only what a call creates counts as new.
    await admin`update nodes set created_at = now() - interval '1 hour'
      where id in ${admin([ids.teamPage, ids.clientPage, ids.otherTeamPage])}`;
    // An app (admin) exporting one client-level table; another app exporting a team one.
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${ids.app}, ${ownerId}, 'app', ${`${tag} app`}, 'apps', 'admin'),
      (${ids.appTeamOnly}, ${ownerId}, 'app', ${`${tag} app 2`}, 'apps', 'admin'),
      (${ids.appTable}, ${ownerId}, 'table', ${`${tag} app table`}, 'tables', 'client'),
      (${ids.appTableTeam}, ${ownerId}, 'table', ${`${tag} app table 2`}, 'tables', 'team')`;
    await admin`insert into app_table_exports (owner_id, app_node_id, sqlite_table, table_node_id) values
      (${ownerId}, ${ids.app}, 'rows', ${ids.appTable}),
      (${ownerId}, ${ids.appTeamOnly}, 'rows', ${ids.appTableTeam})`;
    // A tool group and an agent at client level; a group at team level.
    await admin`insert into tool_groups (owner_id, slug, name, tool_slugs, audience) values
      (${ownerId}, ${groupClient}, 'c', ARRAY['client_shared_list', ${`${tag}_tool`}]::text[], 'client'),
      (${ownerId}, ${groupTeam}, 't', ARRAY['page_get']::text[], 'team')`;
    await admin`insert into agents (owner_id, slug, name, model, system_prompt, audience)
      values (${ownerId}, ${agentClient}, 'c', 'fake/model', 'x', 'client')`;
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    const all = [...Object.values(ids), ...created].filter(Boolean);
    for (const id of all) {
      await admin`delete from pending_tool_calls where owner_id = ${ownerId} and args::text like ${`%${id}%`}`;
    }
    await admin`delete from app_table_exports where app_node_id in ${admin([ids.app, ids.appTeamOnly])}`;
    await admin`delete from nodes where id in ${admin(all)}`;
    await admin`delete from nodes where owner_id = ${ownerId} and title like ${`${tag}%`}`;
    await admin`delete from tool_groups where owner_id = ${ownerId} and slug in ${admin([groupClient, groupTeam])}`;
    await admin`delete from agents where owner_id = ${ownerId} and slug = ${agentClient}`;
    await m.closeDb();
  });

  it('a turn that read a client request: the lowering, the write into a client page and a child under it wait', async () => {
    const res = await turn([
      [['task_get', { id: ids.clientTask }]],
      [
        ['access_set', { node_id: ids.teamPage, level: 'client' }],
        ['page_update', { id: ids.clientPage, markdown: `LEAKED ${tag}` }],
        ['page_create', { title: `${tag} child of client`, parent_id: ids.clientPage }],
        ['page_update', { id: ids.otherTeamPage, markdown: `TEAMEDIT ${tag}` }],
        ['note_create', { title: `${tag} copied note`, content: 'what the client asked' }],
        ['page_create', { title: `${tag} child of team`, parent_id: ids.otherTeamPage }],
      ],
    ]);
    // Three queued, with the original arguments, for the owner to approve.
    expect((await pendingFor(ids.teamPage)).map((r) => r.args)).toEqual([
      { node_id: ids.teamPage, level: 'client' },
    ]);
    expect((await pendingFor(ids.clientPage)).map((r) => r.tool_slug).sort()).toEqual([
      'page_create',
      'page_update',
    ]);
    expect(res.pendingIds).toHaveLength(3);
    // Nothing happened.
    expect(await audience(ids.teamPage)).toBe('team');
    expect(await docHas(ids.clientPage, 'LEAKED')).toBe(false);
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
        ['page_update', { id: ids.clientPage, markdown: `APPROVED ${tag}` }],
      ],
    ]);
    expect(res.pendingIds).toEqual([]);
    expect(await audience(ids.teamPage)).toBe('client');
    expect(await docHas(ids.clientPage, 'APPROVED')).toBe(true);
  });

  it('the lookups: an app exporting a client table, a client group or agent, and their team twins', async () => {
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
    expect(
      (await gate('tool_group_ensure', { slug: groupClient, tool_slugs: ['page_get'] })).gate,
    ).toBe(true);
    expect(await gate('tool_group_ensure', { slug: groupTeam, tool_slugs: ['page_get'] })).toEqual({
      gate: false,
    });
    // A new group runs (it starts at admin level).
    expect(await gate('tool_group_ensure', { slug: `${tag}-new`, tool_slugs: [] })).toEqual({
      gate: false,
    });
    // An API tool already in the client group, edited by slug.
    expect((await gate('api_tool_update', { slug: `${tag}_tool`, url: 'https://x' })).gate).toBe(
      true,
    );
    expect(await gate('api_tool_update', { slug: `${tag}_other`, url: 'https://x' })).toEqual({
      gate: false,
    });
    expect(
      (await gate('agent_grant_tool_group', { agent_slug: agentClient, group_slug: groupTeam }))
        .gate,
    ).toBe(true);
    // An id of no item of this brain waits (fail closed).
    expect((await gate('page_update', { id: randomUUID(), title: 'x' })).gate).toBe(true);
    // A write into a team item runs; into a client item waits.
    expect(await gate('page_update', { id: ids.otherTeamPage, title: 'x' })).toEqual({
      gate: false,
    });
    expect((await gate('table_row_add', { table_id: ids.appTable, cells: {} })).gate).toBe(true);
  });

  it('folder sharing: a move into, a write into, or a file created in a client-shared folder waits', async () => {
    const gate = (slug: string, input: Record<string, unknown>) =>
      rules.clientSourcedGate({
        ownerId,
        tool: { slug, handler: { kind: 'builtin', ref: slug } },
        input,
        isReadOnlyBuiltin: tools.isBuiltinReadOnly,
      });
    const label = tag.replace(/-/g, '_');
    const f = {
      shared: randomUUID(),
      plain: randomUUID(),
      plain2: randomUUID(),
      inShared: randomUUID(),
      inPlain: randomUUID(),
      filesShared: randomUUID(),
      filesPlain: randomUUID(),
    };
    created.push(...Object.values(f));
    await admin`insert into nodes (id, owner_id, type, title, path, data) values
      (${f.shared}, ${ownerId}, 'branch', ${`${tag} shared`}, ${`notes.${label}_shared`}, '{}'::jsonb),
      (${f.plain}, ${ownerId}, 'branch', ${`${tag} plain`}, ${`notes.${label}_plain`}, '{}'::jsonb),
      (${f.plain2}, ${ownerId}, 'branch', ${`${tag} plain2`}, ${`notes.${label}_plain2`}, '{}'::jsonb),
      (${f.inShared}, ${ownerId}, 'note', ${`${tag} in shared`}, ${`notes.${label}_shared`}, '{}'::jsonb),
      (${f.inPlain}, ${ownerId}, 'note', ${`${tag} in plain`}, ${`notes.${label}_plain`}, '{}'::jsonb),
      (${f.filesShared}, ${ownerId}, 'branch', ${`${tag} files shared`}, ${`files.${label}_shared`}, '{}'::jsonb),
      (${f.filesPlain}, ${ownerId}, 'branch', ${`${tag} files plain`}, ${`files.${label}_plain`}, '{}'::jsonb)`;
    await admin`update nodes set share_level = 'client' where id in ${admin([f.shared, f.filesShared])}`;

    // Moving an admin note into the client-shared folder waits; elsewhere runs.
    expect(
      (await gate('tree_item_move', { kind: 'notes', item_ids: [f.inPlain], folder_id: f.shared }))
        .gate,
    ).toBe(true);
    expect(
      await gate('tree_item_move', { kind: 'notes', item_ids: [f.inPlain], folder_id: f.plain2 }),
    ).toEqual({ gate: false });
    expect(
      await gate('tree_item_move', { kind: 'notes', item_ids: [f.inPlain], folder_id: null }),
    ).toEqual({ gate: false });
    // A folder moved under it waits; the shared folder itself, and what it
    // holds (admin by its own level, client through the folder), wait.
    expect(
      (await gate('tree_folder_update', { kind: 'notes', folder_id: f.plain, parent_id: f.shared }))
        .gate,
    ).toBe(true);
    expect(
      (await gate('tree_folder_update', { kind: 'notes', folder_id: f.shared, name: 'x' })).gate,
    ).toBe(true);
    expect(
      (await gate('tree_item_move', { kind: 'notes', item_ids: [f.inShared], folder_id: f.plain }))
        .gate,
    ).toBe(true);
    // A file created by path in it (or below it) waits; in a plain folder runs.
    const file = (parent_path: string) =>
      gate('file_create', { parent_path, filename: 'x.md', content: 'x' });
    expect((await file(`files.${label}_shared`)).gate).toBe(true);
    expect((await file(`files.${label}_shared.sub`)).gate).toBe(true);
    expect(await file(`files.${label}_plain`)).toEqual({ gate: false });
    // A path that does not parse waits (fail closed).
    expect((await file('not a path!')).gate).toBe(true);
  });
});
