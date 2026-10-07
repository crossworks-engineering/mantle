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

describe.skipIf(!URL)('MCP as a login (tool layer)', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let ls: typeof import('./login-surface');
  let sqlTag: typeof import('drizzle-orm').sql;
  let McpServer: typeof import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
  let Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  let InMemoryTransport: typeof import('@modelcontextprotocol/sdk/inMemory.js').InMemoryTransport;
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
    ({ McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js'));
    ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
    ({ InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js'));
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
    ];
    for (const slug of tools) {
      await exec(sqlTag`
        insert into tools (owner_id, slug, name, description, handler, input_schema)
        values (${anchor}, ${slug}, ${slug}, ${`${slug} tool`}, ${b(slug)}::jsonb,
          '{"type":"object","properties":{}}'::jsonb)`);
    }
    await exec(sqlTag`
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled) values
        (${anchor}, 'g-team', 'g', ARRAY['note_list','note_create','my_items_list'], 'team', true),
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
    expect(list).toEqual(['my_items_list', 'note_list']);
    const res = await c.callTool({ name: 'note_create', arguments: { title: 'x' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not found|unknown/i);
  });

  it('a client gets the client list only, whatever its groups hold', async () => {
    const c = await connect(asClient());
    expect(await names(c)).toEqual(['client_shared_list', 'my_items_list']);
  });

  it('write on: a member draft lands in their own space; a library write is refused', async () => {
    const c = await connect(asMember(true));
    const list = await names(c);
    expect(list).toContain('my_note_create');
    expect(list).toContain('my_item_submit');
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

    const lib = await c.callTool({
      name: 'note_create',
      arguments: { title: `${tag} library write`, content: 'x' },
    });
    expect(lib.isError).toBe(true);
    const [leak] = (await exec(sqlTag`
      select id from nodes where title = ${`${tag} library write`}`)) as unknown as unknown[];
    expect(leak).toBeUndefined();
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
});
