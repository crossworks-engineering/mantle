/**
 * Inbound API keys held to their scope, on a real migrated Postgres through
 * the real app (createApp), and on /api/mcp through its caller lookup:
 *
 *  - /api/v1: a read key cannot write (403 key-read-only), a key limited to
 *    some areas cannot reach the others or an any-item route (403
 *    key-area), a path outside the v1 table is a 404 for a key;
 *  - a task comment through /api/v1/tasks/:id/comments is held to tasks;
 *  - table rows land on the draft and commit publishes them;
 *  - a write made with a key leaves an api.write row naming the key;
 *  - a key that acts as a member reaches whoami and nothing else on v1;
 *  - /api/mcp: an admin key's caller carries its write switch, risky tools
 *    and areas; a member key needs the login's MCP switch and writes only
 *    while both the key and the login's Write switch allow it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/access-keys-scope.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

describe.skipIf(!URL)('inbound API keys: scope', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let tokens: typeof import('./auth/tokens');
  let mcpAuth: typeof import('./mcp-auth');
  let anchor = '';
  const tag = `akscope-${randomUUID().slice(0, 8)}`;
  const PASSWORD = 'a long enough password';
  const admin = randomUUID();
  const member = randomUUID();
  const all = [admin, member];
  const emailOf = (s: string) => `${tag}-${s}@example.com`;
  const nodesMade: string[] = [];
  let ip = 0;

  const call = async (
    path: string,
    init: { method?: string; cookie?: string; bearer?: string; body?: unknown } = {},
  ) => {
    ip += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${ip % 250}`,
    };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    return app.request(path, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  };
  const json = async (res: Response) => (await res.json()) as Json;
  const cookieOf = (id: string) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
  const adminCookie = () => cookieOf(admin);
  /** A key made by `as` for its own login (nobody makes one for another). */
  const makeKey = async (body: Json, as = admin): Promise<{ id: string; secret: string }> => {
    const res = await call('/api/access-keys', {
      method: 'POST',
      cookie: cookieOf(as),
      body: { name: 'Scope test', access: 'read', areas: null, password: PASSWORD, ...body },
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: string; secret: string };
  };
  const audited = async (action: string, keyId: string) => {
    for (let i = 0; i < 100; i += 1) {
      const rows = await sql<Row[]>`
        select path, detail from audit_log
        where action = ${action} and detail->>'keyId' = ${keyId}`;
      if (rows.length) return rows;
      await new Promise((r) => setTimeout(r, 20));
    }
    return [];
  };
  const mcpCaller = (secret: string) =>
    mcpAuth.resolveMcpCaller(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'x-forwarded-for': '203.0.113.9' },
      }),
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'access-keys-scope-db-test-secret-32-chars-plus';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./auth/tokens');
    mcpAuth = await import('./mcp-auth');
    anchor = await ensureTestAnchor(sql);
    const hash = bcrypt.hashSync(PASSWORD, 4);
    await sql`insert into auth.users (id, email, password_hash, role, display_name) values
      (${admin}, ${emailOf('admin')}, ${hash}, 'admin', 'Ada Admin'),
      (${member}, ${emailOf('member')}, ${hash}, 'member', 'Mia Member')`;
    const { createApp } = await import('../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    const keys = await sql<
      Row[]
    >`select id::text as id from access_keys where login_id in ${sql(all)}`;
    const ids = keys.map((k) => String(k.id));
    if (ids.length) await sql`delete from audit_log where detail->>'keyId' in ${sql(ids)}`;
    await sql`delete from access_keys where login_id in ${sql(all)}`;
    if (nodesMade.length) await sql`delete from nodes where id in ${sql(nodesMade)}`;
    await sql`delete from mcp_login_access where login_id in ${sql(all)}`;
    await sql`delete from spaces where login_id in ${sql(all)}`;
    await sql`delete from auth.users where id in ${sql(all)}`;
  });

  // ── /api/v1 ───────────────────────────────────────────────────────────────

  it('a read key reads but never writes, and a refusal is audited', async () => {
    const key = await makeKey({ access: 'read' });
    expect((await call('/api/v1/pages', { bearer: key.secret })).status).toBe(200);
    const res = await call('/api/v1/pages', {
      method: 'POST',
      bearer: key.secret,
      body: { title: `${tag} page` },
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: 'forbidden', reason: 'key-read-only' });
    const refused = await audited('key.refused', key.id);
    expect((refused[0]!.detail as Json).reason).toBe('key-read-only');
  });

  it('a key limited to tasks reaches tasks only', async () => {
    const key = await makeKey({ access: 'read_write', areas: ['tasks'] });
    const page = await call('/api/v1/pages', { bearer: key.secret });
    expect(page.status).toBe(403);
    expect(await json(page)).toMatchObject({ reason: 'key-area' });
    // An any-item route belongs to no area: only an all-areas key.
    const node = await call(`/api/v1/nodes/${randomUUID()}`, { bearer: key.secret });
    expect(node.status).toBe(403);

    const made = await call('/api/v1/tasks', {
      method: 'POST',
      bearer: key.secret,
      body: { title: `${tag} task` },
    });
    expect(made.status).toBe(201);
    const task = (await json(made)) as { task?: { id: string }; id?: string };
    const taskId = task.task?.id ?? task.id!;
    nodesMade.push(taskId);
    expect((await call(`/api/v1/tasks/${taskId}`, { bearer: key.secret })).status).toBe(200);

    const comment = await call(`/api/v1/tasks/${taskId}/comments`, {
      method: 'POST',
      bearer: key.secret,
      body: { body: 'From a script.' },
    });
    expect(comment.status).toBe(201);

    // The write names the key in the audit log, attributed to its login.
    const writes = await audited('api.write', key.id);
    expect(writes.map((w) => w.path)).toContain('/api/v1/tasks');
    // It names the key's maker too (audit item 8).
    expect((writes[0]!.detail as Json).keyCreatedBy).toBe(admin);
  });

  it('a task comment through v1 is held to tasks', async () => {
    const pageRes = await call('/api/pages', {
      method: 'POST',
      cookie: adminCookie(),
      body: { title: `${tag} not a task` },
    });
    expect(pageRes.status).toBe(201);
    const pageBody = (await json(pageRes)) as { page?: { id: string }; id?: string };
    const pageId = pageBody.page?.id ?? pageBody.id!;
    nodesMade.push(pageId);
    const key = await makeKey({ access: 'read_write', areas: ['tasks'] });
    const res = await call(`/api/v1/tasks/${pageId}/comments`, {
      method: 'POST',
      bearer: key.secret,
      body: { body: 'x' },
    });
    expect(res.status).toBe(404);
  });

  it('table rows land on the draft; commit publishes them', async () => {
    const created = await call('/api/tables', {
      method: 'POST',
      cookie: adminCookie(),
      body: { title: `${tag} table` },
    });
    expect(created.status).toBe(201);
    const tableId = ((await json(created)) as { table: { id: string } }).table.id;
    nodesMade.push(tableId);

    const reader = await makeKey({ access: 'read', areas: ['tables'] });
    expect(
      (
        await call(`/api/v1/tables/${tableId}/rows`, {
          method: 'POST',
          bearer: reader.secret,
          body: { rows: [{ Name: 'nope' }] },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(`/api/v1/tables/${tableId}/rows/r1`, {
          method: 'PATCH',
          bearer: reader.secret,
          body: { cells: { Name: 'nope' } },
        })
      ).status,
    ).toBe(403);

    const writer = await makeKey({ access: 'read_write', areas: ['tables'] });
    const added = await call(`/api/v1/tables/${tableId}/rows`, {
      method: 'POST',
      bearer: writer.secret,
      body: { rows: [{ Name: `${tag}-alpha` }] },
    });
    expect(added.status).toBe(201);
    const commit = await call(`/api/v1/tables/${tableId}/commit`, {
      method: 'POST',
      bearer: writer.secret,
      body: {},
    });
    expect(commit.status).toBe(200);
    const rows = await call(`/api/v1/tables/${tableId}/rows`, { bearer: reader.secret });
    expect(rows.status).toBe(200);
    expect(await rows.text()).toContain(`${tag}-alpha`);
  });

  it('a key never confirms a change of who can see an item (F1)', async () => {
    const folderRes = await call('/api/tree/pages/folders', {
      method: 'POST',
      cookie: adminCookie(),
      body: { parentId: null, name: `${tag} shared` },
    });
    expect(folderRes.status).toBe(201);
    const folderId = ((await json(folderRes)) as { folder: { id: string } }).folder.id;
    nodesMade.push(folderId);
    const share = await call(`/api/tree/pages/folders/${folderId}`, {
      method: 'PATCH',
      cookie: adminCookie(),
      body: { share: 'team', confirm: true },
    });
    expect(share.status).toBe(200);

    const key = await makeKey({ access: 'read_write', areas: ['pages'] });
    const res = await call('/api/v1/pages', {
      method: 'POST',
      bearer: key.secret,
      body: { title: `${tag} into shared`, folderId, confirm: true },
    });
    expect(res.status).toBe(409);
    // A person with a session may still confirm.
    const byPerson = await call('/api/pages', {
      method: 'POST',
      cookie: adminCookie(),
      body: { title: `${tag} into shared`, folderId, confirm: true },
    });
    expect(byPerson.status).toBe(201);
    nodesMade.push(((await json(byPerson)) as { page: { id: string } }).page.id);
  });

  it('a key cannot change who can see a page (suspected item 1)', async () => {
    const made = await call('/api/pages', {
      method: 'POST',
      cookie: adminCookie(),
      body: { title: `${tag} private page` },
    });
    const pageId = ((await json(made)) as { page: { id: string } }).page.id;
    nodesMade.push(pageId);
    const key = await makeKey({ access: 'read_write', areas: ['pages'] });
    const publish = await call(`/api/v1/pages/${pageId}`, {
      method: 'PATCH',
      bearer: key.secret,
      body: { visibility: 'public' },
    });
    expect(publish.status).toBe(403);
    expect(await json(publish)).toMatchObject({ reason: 'key-publish' });
    const rename = await call(`/api/v1/pages/${pageId}`, {
      method: 'PATCH',
      bearer: key.secret,
      body: { title: `${tag} renamed` },
    });
    expect(rename.status).toBe(200);
  });

  it('HEAD is a read, and an encoded path cannot leave /api/v1', async () => {
    const key = await makeKey({ access: 'read', areas: ['pages'] });
    expect((await call('/api/v1/pages', { method: 'HEAD', bearer: key.secret })).status).toBe(200);
    // %2e%2e is a dot segment: the URL becomes /api/pages, where a key is
    // no credential.
    expect((await call('/api/v1/%2e%2e/pages', { bearer: key.secret })).status).toBe(401);
    expect((await call('/api/v1/pages/..%2f..%2fusers', { bearer: key.secret })).status).not.toBe(
      200,
    );
  });

  it('a path outside the v1 table is a 404 for a key', async () => {
    const key = await makeKey({});
    expect((await call('/api/v1/settings', { bearer: key.secret })).status).toBe(404);
    expect(
      (await call(`/api/v1/pages/${randomUUID()}`, { method: 'DELETE', bearer: key.secret }))
        .status,
    ).toBe(404);
  });

  it('a key that acts as a member reaches whoami and no admin route', async () => {
    const key = await makeKey({ access: 'read_write' }, member);
    expect((await call('/api/v1/whoami', { bearer: key.secret })).status).toBe(200);
    const res = await call('/api/v1/pages', { bearer: key.secret });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ reason: 'member-login' });
  });

  // ── /api/mcp ──────────────────────────────────────────────────────────────

  it('a write tool call made with a key leaves an audit row; a read leaves none (F6)', async () => {
    const key = await makeKey({ access: 'read_write' });
    const caller = await mcpCaller(key.secret);
    expect(caller).not.toBeNull();
    const rpc = (name: string) =>
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } }),
      });
    await mcpAuth.auditMcpKeyCall(rpc('note_create'), caller!);
    await mcpAuth.auditMcpKeyCall(rpc('search'), caller!);
    const rows = await audited('api.write', key.id);
    expect(rows.map((r) => (r.detail as Json).tool)).toEqual(['note_create']);
    expect((rows[0]!.detail as Json).keyCreatedBy).toBe(admin);
  });

  it('an admin key on MCP carries its access, risky tools and areas', async () => {
    const key = await makeKey({
      access: 'read',
      areas: ['pages', 'tasks'],
      riskyTools: ['email_send'],
    });
    const caller = await mcpCaller(key.secret);
    expect(caller).toMatchObject({
      role: 'admin',
      anchorId: anchor,
      loginId: admin,
      via: 'key',
      write: false,
      keyId: key.id,
      riskyAllowed: ['email_send'],
      areas: ['pages', 'tasks'],
    });
    await call(`/api/access-keys/${key.id}`, { method: 'DELETE', cookie: adminCookie() });
    expect(await mcpCaller(key.secret)).toBeNull();
  });

  it("a member key on MCP needs the login's switch, and both write switches", async () => {
    const key = await makeKey({ access: 'read_write' }, member);
    expect(await mcpCaller(key.secret)).toBeNull();

    await sql`insert into mcp_login_access (login_id, enabled, write_enabled)
              values (${member}, true, false)
              on conflict (login_id) do update set enabled = true, write_enabled = false`;
    expect(await mcpCaller(key.secret)).toMatchObject({
      role: 'member',
      loginId: member,
      via: 'key',
      write: false,
      keyId: key.id,
      areas: null,
    });

    await sql`update mcp_login_access set write_enabled = true where login_id = ${member}`;
    expect((await mcpCaller(key.secret))?.write).toBe(true);

    const reader = await makeKey({ access: 'read' }, member);
    expect((await mcpCaller(reader.secret))?.write).toBe(false);
  });
});
