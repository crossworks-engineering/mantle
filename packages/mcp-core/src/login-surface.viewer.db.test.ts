/**
 * MCP as a login, at the MCP tool layer, on a real migrated Postgres (plan
 * page e5b854dd). A real McpServer gets the caller's tools through the same
 * path /api/mcp uses (prepareCallerTools + registerPreparedTools) and an MCP
 * client lists and calls them over an in-memory transport.
 *
 *  - a member reads team items, never admin ones, even when the call names
 *    an admin-level tool the list never offered;
 *  - write off: no tool that is not read-only is listed, and calling one
 *    fails as an unknown tool;
 *  - a client gets the client list only, whatever its groups hold;
 *  - write on: a member's draft lands in their own space, and a library
 *    write is neither offered nor done.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/mcp-core/src/login-surface.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpCaller } from './login-surface';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const MY_APP_READS = [
  'my_app_deleted_list',
  'my_app_errors',
  'my_app_get',
  'my_app_guide',
  'my_app_list',
  'my_app_snapshot_list',
];
const MY_APP_SLUGS = [
  ...MY_APP_READS,
  'my_app_create',
  'my_app_file_write',
  'my_app_file_delete',
  'my_app_build',
  'my_app_publish',
  'my_app_schema_set',
  'my_app_tools_set',
  'my_app_snapshot_create',
  'my_app_snapshot_restore',
  'my_app_snapshot_delete',
  'my_app_unshare',
  'my_app_submit',
  'my_app_recall',
  'my_app_delete',
  'my_app_undelete',
];

describe.skipIf(!URL)('MCP as a login (tool layer)', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let ls: typeof import('./login-surface');
  let sqlTag: typeof import('drizzle-orm').sql;
  let McpServer: typeof import('@modelcontextprotocol/server').McpServer;
  let Client: typeof import('@modelcontextprotocol/client').Client;
  let InMemoryTransport: typeof import('@modelcontextprotocol/server').InMemoryTransport;
  const tag = `mcplogin-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const member = randomUUID();
  const client = randomUUID();
  let memberSpace: string;

  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);

  async function connect(caller: McpCaller) {
    const server = new McpServer({ name: 'test', version: '0' });
    ls.registerPreparedTools(server, await ls.prepareCallerTools(caller));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'test-client', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    return c;
  }
  const names = async (c: Awaited<ReturnType<typeof connect>>) =>
    (await c.listTools()).tools.map((t) => t.name).sort();
  const text = (r: unknown) =>
    ((r as { content?: { text?: string }[] }).content ?? []).map((p) => p.text ?? '').join('\n');

  const asMember = (write = false): McpCaller => ({
    role: 'member',
    anchorId: anchor,
    loginId: member,
    displayName: 'Test Member',
    via: 'token',
    write,
  });
  const asClient = (write = false): McpCaller => ({
    role: 'client',
    anchorId: anchor,
    loginId: client,
    via: 'oauth',
    write,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ls = await import('./login-surface');
    sqlTag = (await import('drizzle-orm')).sql;
    ({ McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server'));
    ({ Client } = await import('@modelcontextprotocol/client'));
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);

    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${anchor}, ${`${tag}-o@example.invalid`}, 'x', 'admin'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member'),
        (${client}, ${`${tag}-c@example.invalid`}, 'x', 'client')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`,
    );
    const rows = (await exec(sqlTag`
      select id from spaces where kind = 'personal' and login_id = ${member}`)) as unknown as {
      id: string;
    }[];
    memberSpace = rows[0]!.id;

    const b = (ref: string) => JSON.stringify({ kind: 'builtin', ref });
    const tools = [
      'note_list',
      'note_create',
      'event_list',
      'my_items_list',
      'client_shared_list',
      'my_note_create',
      'my_item_submit',
      'app_db_query',
      'app_data_list',
      'app_data_schema',
      'app_data_query',
      'app_data_write',
      // A member's own apps (team apps Phase 3).
      ...MY_APP_SLUGS,
    ];
    for (const slug of tools) {
      await exec(sqlTag`
        insert into tools (owner_id, slug, name, description, handler, input_schema)
        values (${anchor}, ${slug}, ${slug}, ${`${slug} tool`}, ${b(slug)}::jsonb,
          '{"type":"object","properties":{}}'::jsonb)`);
    }
    await exec(sqlTag`
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled) values
        (${anchor}, 'g-team', 'g', ARRAY['note_list','note_create','my_items_list','app_db_query'], 'team', true),
        (${anchor}, 'g-admin', 'g', ARRAY['event_list'], 'admin', true),
        (${anchor}, 'g-client', 'g', ARRAY['client_shared_list','note_list','my_items_list'], 'client', true)`);
    await exec(sqlTag`
      insert into agents (owner_id, slug, name, model, system_prompt, tool_group_slugs, audience) values
        (${anchor}, 'team-responder', 't', 'm', 'p', ARRAY['g-team','g-admin'], 'team'),
        (${anchor}, 'client-responder', 'c', 'm', 'p', ARRAY['g-client'], 'client')`);
    await exec(sqlTag`
      insert into nodes (owner_id, type, title, path, audience, data) values
        (${anchor}, 'note', ${`${tag} team note`}, 'notes', 'team', '{"content":"t"}'::jsonb),
        (${anchor}, 'note', ${`${tag} admin note`}, 'notes', 'admin', '{"content":"a"}'::jsonb),
        (${anchor}, 'event', ${`${tag} board event`}, 'events', 'admin',
          ${JSON.stringify({ start_at: new Date().toISOString() })}::jsonb)`);
  }, 60_000);

  afterAll(async () => {
    await exec(sqlTag`delete from agents where owner_id = ${anchor}`);
    await exec(sqlTag`delete from tool_groups where owner_id = ${anchor}`);
    await exec(sqlTag`delete from tools where owner_id = ${anchor}`);
    await exec(sqlTag`delete from nodes where owner_id in (${anchor}, ${memberSpace})`);
    await exec(sqlTag`delete from spaces where login_id in (${anchor}, ${member}, ${client})`);
    await exec(sqlTag`delete from auth.users where id in (${anchor}, ${member}, ${client})`);
    await m.closeDb();
  }, 60_000);

  it('a member call runs on the team role: no admin note, unlike the admin pool', async () => {
    // Row security on the team role is keyed on the box's one brain
    // (mantle_brain_id()), which this test's brain is not: on the team role
    // the call sees none of its notes, on the admin pool it sees both. That
    // difference is the proof the MCP call ran on the limited role.
    const c = await connect(asMember());
    const res = await c.callTool({ name: 'note_list', arguments: {} });
    expect(res.isError ?? false).toBe(false);
    expect(text(res)).not.toContain(`${tag} admin note`);
    const [both] = (await exec(sqlTag`
      select count(*)::int as n from nodes where owner_id = ${anchor} and type = 'note'`)) as unknown as {
      n: number;
    }[];
    expect(both?.n).toBe(2);
  });

  it('a member never gets an admin-level group, and RLS holds if one is called anyway', async () => {
    const c = await connect(asMember());
    expect(await names(c)).not.toContain('event_list');
    // Straight through the login runner, past the list: row level security
    // still hides the event (events are admin-only).
    const prepared = await ls.prepareCallerTools(asMember());
    if (prepared.kind !== 'login') throw new Error('expected a login surface');
    const tool = {
      slug: 'event_list',
      description: '',
      inputSchema: {},
      handler: { kind: 'builtin', ref: 'event_list' },
      requiresConfirm: false,
    } as unknown as import('@mantle/db').Tool;
    const res = await ls.callLoginTool(prepared.caller, tool, {}, 'team', false);
    expect(text(res)).not.toContain(`${tag} board event`);
  });

  it('write off: only read-only tools are listed, and a write tool is unknown', async () => {
    const c = await connect(asMember(false));
    const list = await names(c);
    // app_db_query is in the member's group, yet a login's MCP gets the
    // app_data reads instead (team apps Phase 1), and no app_data_write.
    // A member reads their own apps (my_app_*) without write; building
    // them needs it (team apps Phase 3).
    expect(list).toEqual(
      [
        'app_data_list',
        'app_data_query',
        'app_data_schema',
        ...MY_APP_READS,
        'my_items_list',
        'note_list',
      ].sort(),
    );
    // SDK 2.x answers an unknown tool with a protocol error (-32602), where
    // 1.x returned an isError result.
    await expect(c.callTool({ name: 'note_create', arguments: { title: 'x' } })).rejects.toThrow(
      /not found/i,
    );
  });

  it('the app data tools run on the login MCP: the surface stamps the connection', async () => {
    const c = await connect(asMember());
    const res = await c.callTool({ name: 'app_data_list', arguments: {} });
    expect(res.isError ?? false, text(res)).toBe(false);
    expect(JSON.parse(text(res))).toEqual({ apps: [] });
  });

  it('a client gets the client list only, whatever its groups hold', async () => {
    const c = await connect(asClient());
    expect(await names(c)).toEqual([
      'app_data_list',
      'app_data_query',
      'app_data_schema',
      'client_shared_list',
      'my_items_list',
    ]);
  });

  it('write on: a member draft lands in their own space; a library write is refused', async () => {
    const c = await connect(asMember(true));
    const list = await names(c);
    expect(list).toContain('my_note_create');
    expect(list).toContain('my_item_submit');
    expect(list).toContain('app_data_write');
    expect(list).not.toContain('app_db_query');
    expect(list).not.toContain('event_list');
    expect(list).not.toContain('note_create');

    const made = await c.callTool({
      name: 'my_note_create',
      arguments: { title: `${tag} draft`, content: 'by mcp' },
    });
    expect(text(made)).not.toMatch(/^Error/);
    expect(made.isError ?? false).toBe(false);
    const madeId = (JSON.parse(text(made)) as { id: string }).id;
    const [draft] = (await exec(sqlTag`
      select owner_id, title from nodes where id = ${madeId}`)) as unknown as {
      owner_id: string;
      title: string;
    }[];
    expect(draft?.title, text(made)).toBe(`${tag} draft`);
    expect(draft?.owner_id).toBe(memberSpace);

    await expect(
      c.callTool({
        name: 'note_create',
        arguments: { title: `${tag} library write`, content: 'x' },
      }),
    ).rejects.toThrow(/not found/i);
    const [leak] = (await exec(sqlTag`
      select id from nodes where title = ${`${tag} library write`}`)) as unknown as unknown[];
    expect(leak).toBeUndefined();
  });

  it('write on: a member builds an app in their own space, private, at the team ceiling', async () => {
    const c = await connect(asMember(true));
    const list = await names(c);
    for (const s of MY_APP_SLUGS) expect(list, s).toContain(s);
    const made = await c.callTool({ name: 'my_app_create', arguments: { name: `${tag} app` } });
    expect(made.isError ?? false, text(made)).toBe(false);
    const id = (JSON.parse(text(made)) as { id: string }).id;
    const [row] = (await exec(sqlTag`
      select n.owner_id, a.author_level, si.sharing from nodes n
      join apps a on a.node_id = n.id join space_items si on si.node_id = n.id
      where n.id = ${id}`)) as unknown as {
      owner_id: string;
      author_level: string;
      sharing: string;
    }[];
    expect(row).toEqual({ owner_id: memberSpace, author_level: 'team', sharing: 'private' });
    // Every member app change over MCP leaves an audit row (access matrix
    // N8), on any connection.
    let audited: unknown[] = [];
    for (let i = 0; i < 40 && audited.length === 0; i++) {
      audited = (await exec(sqlTag`
        select id from audit_log
        where action = 'mcp.my_app_create' and actor_id = ${member}`)) as unknown as unknown[];
      if (audited.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(audited.length).toBeGreaterThan(0);
    const listed = await c.callTool({ name: 'my_app_list', arguments: {} });
    expect(JSON.parse(text(listed)).apps.map((a: { id: string }) => a.id)).toContain(id);
    // Written by its author only: an app of the brain is not one of theirs.
    const [brainApp] = (await exec(sqlTag`
      insert into nodes (owner_id, type, title, path, audience)
      values (${anchor}, 'app', ${`${tag} brain app`}, 'apps', 'team') returning id`)) as unknown as {
      id: string;
    }[];
    const refused = await c.callTool({
      name: 'my_app_file_write',
      arguments: { id: brainApp!.id, path: 'App.tsx', content: 'x' },
    });
    expect(text(refused)).toMatch(/No such app of yours/);
  });

  // Access matrix N6 (option A) and N8: a member deletes their own app to
  // their trash over MCP and brings it back; each change leaves an audit row.
  it('write on: a member deletes their own app to their trash and brings it back', async () => {
    const c = await connect(asMember(true));
    const made = await c.callTool({
      name: 'my_app_create',
      arguments: { name: `${tag} trash app` },
    });
    const id = (JSON.parse(text(made)) as { id: string }).id;
    const ids = async (tool: string) =>
      (
        JSON.parse(text(await c.callTool({ name: tool, arguments: {} }))).apps as { id: string }[]
      ).map((a) => a.id);

    const deleted = await c.callTool({ name: 'my_app_delete', arguments: { id } });
    expect(deleted.isError ?? false, text(deleted)).toBe(false);
    expect(JSON.parse(text(deleted))).toMatchObject({ id, deleted: true });
    expect(await ids('my_app_list')).not.toContain(id);
    expect(await ids('my_app_deleted_list')).toContain(id);
    // In the trash it is refused for every change, with the way back named.
    const write = await c.callTool({
      name: 'my_app_file_write',
      arguments: { id, path: 'App.tsx', content: 'x' },
    });
    expect(text(write)).toMatch(/my_app_undelete/);
    // Nothing was removed: the node is still the member's, in their space.
    const [row] = (await exec(sqlTag`
      select n.owner_id, si.deleted_at is not null as trashed from nodes n
      join space_items si on si.node_id = n.id where n.id = ${id}`)) as unknown as {
      owner_id: string;
      trashed: boolean;
    }[];
    expect(row).toEqual({ owner_id: memberSpace, trashed: true });

    const back = await c.callTool({ name: 'my_app_undelete', arguments: { id } });
    expect(back.isError ?? false, text(back)).toBe(false);
    expect(JSON.parse(text(back))).toMatchObject({ id, sharing: 'private' });
    expect(await ids('my_app_list')).toContain(id);
    expect(await ids('my_app_deleted_list')).not.toContain(id);

    for (const action of ['mcp.my_app_delete', 'mcp.my_app_undelete']) {
      let audited: { app: string | null }[] = [];
      for (let i = 0; i < 40 && audited.length === 0; i++) {
        audited = (await exec(sqlTag`
          select detail->>'appId' as app from audit_log
          where action = ${action} and actor_id = ${member}`)) as unknown as {
          app: string | null;
        }[];
        if (audited.length === 0) await new Promise((r) => setTimeout(r, 50));
      }
      expect(
        audited.map((a) => a.app),
        action,
      ).toContain(id);
    }
  });

  it('write off: the trash is read only, the delete is not offered', async () => {
    const list = await names(await connect(asMember(false)));
    expect(list).toContain('my_app_deleted_list');
    for (const s of ['my_app_delete', 'my_app_undelete', 'my_app_snapshot_delete']) {
      expect(list, s).not.toContain(s);
    }
  });

  it('a client never gets the my_app tools, write on or off', async () => {
    for (const write of [false, true]) {
      const list = await names(await connect(asClient(write)));
      expect(list.filter((s) => s.startsWith('my_app_'))).toEqual([]);
    }
  });

  it('a responder left above the role level closes MCP to that role, as chat', async () => {
    await exec(sqlTag`update agents set audience = 'admin'
      where owner_id = ${anchor} and slug = 'team-responder'`);
    try {
      const prepared = await ls.prepareCallerTools(asMember(true));
      // The route answers 403 for a login with no tools.
      expect(prepared.kind === 'login' && prepared.rows).toEqual([]);
    } finally {
      await exec(sqlTag`update agents set audience = 'team'
        where owner_id = ${anchor} and slug = 'team-responder'`);
    }
  });

  it('a client with write on gets the draft tools too, and still no library tool', async () => {
    const c = await connect(asClient(true));
    const list = await names(c);
    expect(list).toContain('my_note_create');
    expect(list).not.toContain('note_list');
    expect(list).not.toContain('note_create');
  });

  // Team apps Phase 2: a connector's level decides; its read-only mark
  // decides read (any login with MCP on) or write (write on only).
  it("connector tools by the connector's level, read or write by the mark", async () => {
    const { externalAccessHandlerSig } = await import('@mantle/tools');
    const handler = (toolName: string) => ({ kind: 'mcp', group: 'mcp-src', toolName });
    const mark = JSON.stringify({
      confirmedReadOnlyAt: new Date().toISOString(),
      by: { via: 'web' },
      handlerSig: externalAccessHandlerSig(handler('read') as never),
    });
    const binding = JSON.stringify({
      service: 'mcp-src',
      mcp: { url: 'https://mcp.example.invalid/mcp' },
    });
    await exec(sqlTag`
      insert into tools (owner_id, slug, name, description, handler, input_schema, external_access) values
        (${anchor}, 'mcp_src_read', 'r', 'reads', ${JSON.stringify(handler('read'))}::jsonb,
          '{"type":"object","properties":{}}'::jsonb, ${mark}::jsonb),
        (${anchor}, 'mcp_src_write', 'w', 'writes', ${JSON.stringify(handler('write'))}::jsonb,
          '{"type":"object","properties":{}}'::jsonb, null)`);
    await exec(sqlTag`
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, integration)
      values (${anchor}, 'mcp-src', 'src', ARRAY['mcp_src_read','mcp_src_write'], 'admin', true, ${binding}::jsonb)`);
    const level = (l: string) =>
      exec(
        sqlTag`update tool_groups set audience = ${l} where owner_id = ${anchor} and slug = 'mcp-src'`,
      );
    const connectorNames = async (caller: McpCaller) =>
      (await names(await connect(caller))).filter((n) => n.startsWith('mcp_src_'));
    try {
      // At admin: nobody below admin gets it.
      expect(await connectorNames(asMember(true))).toEqual([]);
      expect(await connectorNames(asClient(true))).toEqual([]);
      // At team: members; the write tool only with write on. Clients: no.
      await level('team');
      expect(await connectorNames(asMember(false))).toEqual(['mcp_src_read']);
      expect(await connectorNames(asMember(true))).toEqual(['mcp_src_read', 'mcp_src_write']);
      expect(await connectorNames(asClient(true))).toEqual([]);
      // At client: clients too (and members, whose level reads client).
      await level('client');
      expect(await connectorNames(asClient(false))).toEqual(['mcp_src_read']);
      expect(await connectorNames(asMember(false))).toEqual(['mcp_src_read']);
      // A key limited to areas never gets a connector tool.
      expect(
        await connectorNames({ ...asMember(true), via: 'key', keyId: 'k', areas: ['app_data'] }),
      ).toEqual([]);
      // Called anyway with write off, the write tool refuses before dispatch.
      const prepared = await ls.prepareCallerTools(asMember(false));
      if (prepared.kind !== 'login') throw new Error('expected a login surface');
      const [row] = (await exec(
        sqlTag`select * from tools where owner_id = ${anchor} and slug = 'mcp_src_write'`,
      )) as unknown as import('@mantle/db').Tool[];
      const refused = await ls.callLoginTool(
        prepared.caller,
        { ...row!, handler: handler('write') } as never,
        {},
        'team',
        false,
      );
      expect(text(refused)).toMatch(/writes, and your MCP connection is read-only/);
      // A read call is logged with the login (the far side is not reached
      // here: the URL does not resolve).
      const { resolveTool } = await import('@mantle/tools');
      const readRow = await resolveTool(anchor, 'mcp_src_read');
      expect(readRow?.externalAccess).toBeTruthy();
      await ls.callLoginTool(
        asMember(false) as McpCaller & { role: 'member' },
        readRow!,
        {},
        'team',
        false,
      );
      let logged: unknown[] = [];
      for (let i = 0; i < 40 && logged.length === 0; i++) {
        logged = (await exec(sqlTag`
          select 1 from audit_log where actor_id = ${member}
            and action = 'mcp.connector.read' and detail->>'tool' = 'mcp_src_read'`)) as unknown as unknown[];
        if (!logged.length) await new Promise((r) => setTimeout(r, 50));
      }
      expect(logged.length).toBeGreaterThan(0);
    } finally {
      await exec(sqlTag`delete from audit_log where actor_id = ${member}`);
      await exec(sqlTag`delete from tool_groups where owner_id = ${anchor} and slug = 'mcp-src'`);
      await exec(sqlTag`delete from tools where owner_id = ${anchor} and slug like 'mcp_src_%'`);
    }
  });
});
