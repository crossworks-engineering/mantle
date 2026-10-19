/**
 * Inbound API keys held to their scope, on a real migrated Postgres through
 * the real app (createApp), and on /api/mcp through its caller lookup. A
 * key acts as its login and reads that login's workspaces; its access and
 * areas only narrow that (workspaces plan 7.5, contract change 35):
 *
 *  - /api/v1: a read key cannot write (403 key-read-only), a key limited to
 *    some areas cannot reach the others or an any-item route (403
 *    key-area), a path outside the v1 table is a 404 for a key;
 *  - task comments are gone: /api/v1/tasks/:id/comments is a 404 for a key;
 *  - table rows land on the draft and commit publishes them;
 *  - a write made with a key leaves an api.write row naming the key;
 *  - a key never confirms a change of who can see an item (F1), and never
 *    changes the content of an item another workspace reads (N3);
 *  - a key that acts as a member answers on v1 as the base route answers
 *    that member (D3, the A8 finding F1): an item route in its scope, an
 *    Admin only route (the journal, the table row writes) refused;
 *  - /api/mcp: an admin key's caller carries its write switch, risky tools
 *    and areas; a member key acts as its login at once (no per-login MCP
 *    switch since W7b) and writes only while the key allows it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/access-keys-scope.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureTestAnchor,
  runWorkspacesSwitch,
  superuserExec,
} from '@mantle/db/test-support';
import { SCOPE_AREAS } from '@mantle/db/viewer';

/** A user of the Admin workspace with every area: what lists everything
 *  (a prepared connection read no narrower). */
const ADMIN_VIEW = { holdsAdmin: true, areas: new Set(SCOPE_AREAS) };

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
  const emailOf = (s: string) => `${tag}-${s}@example.com`;
  const nodesMade: string[] = [];
  const workspacesMade: string[] = [];
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

  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;

  beforeAll(async () => {
    // A brain of its own, on workspaces as every brain is since arch A7: a
    // key's call runs in its login's workspaces, which a brain off
    // workspaces no longer skips.
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
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
    await runWorkspacesSwitch(scratch.url);
    const { createApp } = await import('../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
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

    // Task comments are gone (2026-10-09): outside the v1 table, a 404.
    const comment = await call(`/api/v1/tasks/${taskId}/comments`, {
      method: 'POST',
      bearer: key.secret,
      body: { body: 'From a script.' },
    });
    expect(comment.status).toBe(404);

    // The write names the key in the audit log, attributed to its login.
    const writes = await audited('api.write', key.id);
    expect(writes.map((w) => w.path)).toContain('/api/v1/tasks');
    // It names the key's maker too (audit item 8).
    expect((writes[0]!.detail as Json).keyCreatedBy).toBe(admin);
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
    // Another workspace holds the folder (W5b2: grants, not a share level),
    // so a page filed in it is readable beyond Admin.
    const wsId = randomUUID();
    workspacesMade.push(wsId);
    // As the superuser: the app pools only read the workspace tables.
    await superuserExec(
      scratch!.url,
      m.sql`insert into workspaces (id, owner_id, name) values (${wsId}, ${anchor}, ${`${tag} ws`})`,
    );
    await m.withSubtreeHeads(folderId, [], async (tx) => {
      await tx.execute(
        m.sql`insert into item_grants (node_id, workspace_id) values (${folderId}, ${wsId})`,
      );
    });

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
    const sharedPage = ((await json(byPerson)) as { page: { id: string } }).page.id;
    nodesMade.push(sharedPage);

    // N3: the doc of a page others can read is not a key's to change (what
    // it embeds would become readable to them); its title still is.
    const doc = await call(`/api/v1/pages/${sharedPage}`, {
      method: 'PATCH',
      bearer: key.secret,
      body: { doc: { type: 'doc', content: [] } },
    });
    expect(doc.status).toBe(403);
    expect(await json(doc)).toMatchObject({ reason: 'key-shared-item' });
    const title = await call(`/api/v1/pages/${sharedPage}`, {
      method: 'PATCH',
      bearer: key.secret,
      body: { title: `${tag} retitled` },
    });
    expect(title.status).toBe(200);

    // The same rule on MCP: an admin key's page_update on that page is refused.
    const caller = await mcpCaller(key.secret);
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const fakeServer = {
      registerTool: (name: string, ...rest: unknown[]) =>
        void handlers.set(
          name,
          rest[rest.length - 1] as (a: Record<string, unknown>) => Promise<unknown>,
        ),
    };
    const core = await import('@mantle/mcp-core');
    core.registerPreparedTools(fakeServer as never, {
      kind: 'owner',
      caller: caller!,
      view: ADMIN_VIEW,
      privateWs: null,
      connectors: [],
    });
    const update = handlers.get('page_update');
    expect(update).toBeDefined();
    const out = (await update!({ id: sharedPage, title: `${tag} via mcp` })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('this item is shared');

    // Final audit F1: a padded id is trimmed BEFORE the check (the handler
    // would trim it too), and a field that is not a UUID is refused.
    const padded = (await update!({ id: `  ${sharedPage}\n`, title: 'x' })) as typeof out;
    expect(padded.isError).toBe(true);
    expect(padded.content[0]!.text).toContain('this item is shared');
    const odd = (await update!({ id: 'not-an-id', title: 'x' })) as typeof out;
    expect(odd.isError).toBe(true);
    expect(odd.content[0]!.text).toContain('UUID');
    const replace = handlers.get('page_replace_from_file');
    if (replace) {
      const viaFile = (await replace({ page_id: sharedPage, file_id: randomUUID() })) as typeof out;
      expect(viaFile.isError).toBe(true);
    }
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

  it('a key that acts as a member answers as the base route answers that member (A8 F1)', async () => {
    const key = await makeKey({ access: 'read_write' }, member);
    expect((await call('/api/v1/whoami', { bearer: key.secret })).status).toBe(200);
    // An item route: the member's own scope, as /api/pages answers it.
    const pages = await call('/api/v1/pages', { bearer: key.secret });
    expect(pages.status).toBe(200);
    // An Admin only base route, and a v1 write with no base: refused.
    for (const [method, path] of [
      ['GET', '/api/v1/journal'],
      ['POST', `/api/v1/tables/${randomUUID()}/rows`],
    ] as const) {
      const res = await call(path, {
        method,
        bearer: key.secret,
        ...(method === 'POST' ? { body: { rows: [{ a: 1 }] } } : {}),
      });
      expect(res.status, path).toBe(403);
      expect(await json(res)).toMatchObject({ reason: 'member-login' });
    }
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
    await mcpAuth.auditMcpKeyCall(rpc('note_create'), caller!, () => true);
    await mcpAuth.auditMcpKeyCall(rpc('search'), caller!, () => true);
    // A call the key was not given (out of its scope) leaves no row.
    await mcpAuth.auditMcpKeyCall(rpc('email_send'), caller!, (s) => s !== 'email_send');
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

  it('a member key on MCP acts as its login, held to its own write switch (W7b)', async () => {
    const key = await makeKey({ access: 'read_write' }, member);
    // No per-login switch: the key acts as the member at once.
    expect(await mcpCaller(key.secret)).toMatchObject({
      role: 'member',
      loginId: member,
      via: 'key',
      write: true,
      keyId: key.id,
      areas: null,
    });
    // A read key narrows its login: it never writes.
    const reader = await makeKey({ access: 'read' }, member);
    expect((await mcpCaller(reader.secret))?.write).toBe(false);
  });
});
