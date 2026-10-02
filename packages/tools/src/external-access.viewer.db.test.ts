/**
 * "External access" on a real, migrated Postgres (external-access.ts,
 * docs/member-logins.md "External access: outside tools in shared apps").
 * The remote MCP server is a fake: `mcpCallRemoteTool` is stood in, so no
 * connector or site data is ever reached. Proves: an outside tool is refused
 * until an admin switches it on with the read-only confirmation; on, it needs
 * the app's declaration and nothing else (no group level), for a member, a
 * client app and a contact link alike; it runs under the caller's role; a
 * disabled connector still refuses the call; confirm-gated, shell and recipe
 * tools never get it, nor any built-in on a link; switching off, a changed
 * handler or a moved connector refuses the next call; the author warnings
 * follow the switch; only the owner's MCP client may switch it on through
 * `api_tool_update`; each switch writes an audit row with the actor.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/external-access.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ toolName: string; args: Record<string, unknown> }>,
}));

vi.mock('./mcp-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mcpCallRemoteTool: vi.fn(
    async (
      _o: string,
      _g: string,
      _m: unknown,
      toolName: string,
      args: Record<string, unknown>,
    ) => {
      fake.calls.push({ toolName, args });
      return { text: '{"rows":[{"n":1}]}', isError: false, secrets: new Map<string, string>() };
    },
  ),
}));

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('external access to an outside tool', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let ta: typeof import('./external-access');
  let level: typeof import('./app-tool-level');
  let crud: typeof import('./crud');
  let dispatch: typeof import('./dispatch');
  let builtins: typeof import('./builtins');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `tapps-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const appId = randomUUID();
  const ids: Record<string, string> = {};
  const ADMIN = { via: 'web' as const, actorId: anchor, actorEmail: `${tag}@example.invalid` };
  const DECLARED = [
    'site_query',
    'site_admin_only',
    'site_confirm',
    'site_shell',
    'site_recipe',
    'site_http',
    'quick_sum',
  ];

  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const verdict = (slug: string, declared = DECLARED) =>
    level.appToolVerdict('team', anchor, declared, slug);
  const switchOn = (slug: string) =>
    ta.setToolExternalAccess(anchor, ids[slug]!, {
      allow: true,
      readOnlyConfirmed: true,
      by: ADMIN,
    });
  const switchOff = (slug: string) =>
    ta.setToolExternalAccess(anchor, ids[slug]!, { allow: false, by: ADMIN });
  const toolDef = (slug: string) => {
    const def = builtins.BUILTIN_TOOLS.find((t) => t.slug === slug);
    if (!def) throw new Error(`${slug} is not a builtin any more`);
    return def;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ta = await import('./external-access');
    level = await import('./app-tool-level');
    crud = await import('./crud');
    dispatch = await import('./dispatch');
    builtins = await import('./builtins');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);

    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${anchor}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`,
    );
    const mcp = (toolName: string) => JSON.stringify({ kind: 'mcp', group: 'mcp-site', toolName });
    const http = JSON.stringify({
      kind: 'http',
      url: 'https://api.example.test/rows',
      method: 'GET',
    });
    const recipe = JSON.stringify({ kind: 'recipe', steps: [{ tool: 'site_query' }] });
    await exec(sqlTag`
      insert into tools (owner_id, slug, name, description, handler, requires_confirm) values
        (${anchor}, 'site_query', 'n', 'd', ${mcp('query')}::jsonb, false),
        (${anchor}, 'site_admin_only', 'n', 'd', ${mcp('other')}::jsonb, false),
        (${anchor}, 'site_confirm', 'n', 'd', ${mcp('confirmed')}::jsonb, true),
        (${anchor}, 'site_shell', 'n', 'd', '{"kind":"shell","cmd":"true"}'::jsonb, false),
        (${anchor}, 'site_recipe', 'n', 'd', ${recipe}::jsonb, false),
        (${anchor}, 'site_http', 'n', 'd', ${http}::jsonb, false),
        (${anchor}, 'quick_sum', 'n', 'd', '{"kind":"builtin","ref":"summarize_text"}'::jsonb, false)`);
    const rows = (await exec(
      sqlTag`select id, slug from tools where owner_id = ${anchor}`,
    )) as unknown as Array<{ id: string; slug: string }>;
    for (const r of rows) ids[r.slug] = r.id;
    const binding = JSON.stringify({
      service: 'mcp-site',
      mcp: { url: 'https://mcp.example.test/mcp' },
    });
    await exec(sqlTag`
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, integration) values
        (${anchor}, 'mcp-site', 'a site connector', ARRAY['site_query','site_confirm'], 'team', true, ${binding}::jsonb),
        (${anchor}, 'g-team', 'g', ARRAY['site_shell','site_recipe','site_http','quick_sum'], 'team', true, null),
        (${anchor}, 'g-admin', 'g', ARRAY['site_admin_only'], 'admin', true, null)`);
    await exec(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${appId}, ${anchor}, 'app', ${`${tag} app`}, 'apps', 'team')`);
    await exec(sqlTag`insert into apps (node_id) values (${appId})`);
  }, 60_000);

  afterAll(async () => {
    await exec(sqlTag`
      delete from audit_log where detail->>'toolId' in
        (select id::text from tools where owner_id = ${anchor})`);
    await exec(sqlTag`delete from tool_groups where owner_id = ${anchor}`);
    await exec(sqlTag`delete from tools where owner_id = ${anchor}`);
    await exec(sqlTag`delete from nodes where owner_id = ${anchor}`);
    await exec(sqlTag`delete from spaces where login_id = ${anchor}`);
    await exec(sqlTag`delete from auth.users where id = ${anchor}`);
    await m.closeDb();
  }, 60_000);

  it('refuses an MCP tool with the switch off, as before', async () => {
    expect(await verdict('site_query')).toMatchObject({
      ok: false,
      status: 403,
      reason: expect.stringMatching(/without External access/),
    });
  });

  it('will not switch on without the read-only confirmation', async () => {
    const res = await ta.setToolExternalAccess(anchor, ids.site_query!, { allow: true, by: ADMIN });
    expect(res).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringMatching(/only reads/),
    });
    expect((await verdict('site_query')).ok).toBe(false);
  });

  it('on + declared: a member may call it, and it runs under the team role', async () => {
    const res = await switchOn('site_query');
    expect(res.ok).toBe(true);
    const v = await verdict('site_query');
    if (!v.ok) throw new Error(v.reason);
    const scope = level.appToolScope('team', { loginId: randomUUID(), name: 'A member' });
    expect(scope).toMatchObject({ viewer: 'team', surface: { kind: 'team', privateReads: false } });
    fake.calls.length = 0;
    const out = await m.withViewer(scope.viewer, () =>
      dispatch.dispatchTool(v.tool, { q: 'x' }, { ownerId: anchor, surface: scope.surface }),
    );
    expect(out).toMatchObject({ ok: true, output: { rows: [{ n: 1 }] }, untrusted: true });
    expect(fake.calls).toEqual([{ toolName: 'query', args: { q: 'x' } }]);
  });

  it('still needs the declaration', async () => {
    expect(await verdict('site_query', ['site_http'])).toMatchObject({ ok: false, status: 403 });
  });

  it('on: a group level does not gate it (held only by an admin-level group)', async () => {
    expect((await switchOn('site_admin_only')).ok).toBe(true);
    expect((await verdict('site_admin_only')).ok).toBe(true);
  });

  it('its connector switched off: the call is refused (dispatch reads the connector each call)', async () => {
    await exec(
      sqlTag`update tool_groups set enabled = false where owner_id = ${anchor} and slug = 'mcp-site'`,
    );
    try {
      const v = await verdict('site_query');
      if (!v.ok) throw new Error(v.reason);
      fake.calls.length = 0;
      const out = await m.withViewer('team', () =>
        dispatch.dispatchTool(v.tool, {}, { ownerId: anchor, surface: { kind: 'team' } }),
      );
      expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/disabled/) });
      expect(fake.calls).toEqual([]);
    } finally {
      await exec(
        sqlTag`update tool_groups set enabled = true where owner_id = ${anchor} and slug = 'mcp-site'`,
      );
    }
    expect((await verdict('site_query')).ok).toBe(true);
  });

  it('a client-level app may call it while the switch is on, under the client role', async () => {
    const v = await level.appToolVerdict('client', anchor, DECLARED, 'site_query');
    if (!v.ok) throw new Error(v.reason);
    const scope = level.appToolScope('client', { loginId: randomUUID(), name: 'A client' });
    fake.calls.length = 0;
    const out = await m.withViewer(scope.viewer, () =>
      dispatch.dispatchTool(v.tool, { q: 'c' }, { ownerId: anchor, surface: scope.surface }),
    );
    expect(out).toMatchObject({ ok: true, output: { rows: [{ n: 1 }] } });
    expect(fake.calls).toEqual([{ toolName: 'query', args: { q: 'c' } }]);
    // An admin's or a member's run of a client app gets the client rules too.
    expect(level.appToolLevel('team', 'client')).toBe('client');
    expect(level.appToolLevel('admin', 'client')).toBe('client');
    // Off: refused, and a built-in off the client list stays refused.
    await switchOff('site_query');
    try {
      expect(await level.appToolVerdict('client', anchor, DECLARED, 'site_query')).toMatchObject({
        ok: false,
        status: 403,
        reason: expect.stringMatching(/client app/),
      });
      expect(await level.appToolVerdict('client', anchor, DECLARED, 'quick_sum')).toMatchObject({
        ok: false,
        status: 403,
      });
    } finally {
      await switchOn('site_query');
    }
  });

  it('a contact link: only a declared outside tool with the switch on, never a built-in', async () => {
    const v = await ta.contactAppToolVerdict(anchor, DECLARED, 'site_query');
    if (!v.ok) throw new Error(v.reason);
    fake.calls.length = 0;
    const out = await m.withViewer('public', () =>
      dispatch.dispatchTool(
        v.tool,
        { q: 'l' },
        {
          ownerId: anchor,
          surface: { kind: 'contact', contactId: randomUUID(), shareId: randomUUID() },
        },
      ),
    );
    expect(out).toMatchObject({ ok: true, output: { rows: [{ n: 1 }] } });
    expect(fake.calls).toEqual([{ toolName: 'query', args: { q: 'l' } }]);
    expect(await ta.contactAppToolVerdict(anchor, ['site_http'], 'site_query')).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await ta.contactAppToolVerdict(anchor, DECLARED, 'quick_sum')).toMatchObject({
      ok: false,
      status: 403,
      reason: expect.stringMatching(/built in/),
    });
    expect(await ta.contactAppToolVerdict(anchor, DECLARED, 'site_http')).toMatchObject({
      ok: false,
      status: 403,
      reason: expect.stringMatching(/shared link/),
    });
  });

  it('a confirm-gated tool cannot be switched on, and a gate added later refuses the call', async () => {
    expect(await switchOn('site_confirm')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/confirmation/),
    });
    await crud.updateTool(anchor, ids.site_query!, { requiresConfirm: true });
    try {
      expect((await verdict('site_query')).ok).toBe(false);
    } finally {
      await crud.updateTool(anchor, ids.site_query!, { requiresConfirm: false });
    }
    expect((await verdict('site_query')).ok).toBe(true);
  });

  it('shell and recipe tools can never be switched on, nor pass with the column set by hand', async () => {
    expect(await switchOn('site_shell')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/shell/),
    });
    expect(await switchOn('site_recipe')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/recipe/),
    });
    for (const slug of ['site_shell', 'site_recipe']) {
      const handler = (
        (await exec(
          sqlTag`select handler from tools where id = ${ids[slug]!}`,
        )) as unknown as Array<{
          handler: import('@mantle/db').ToolHandler;
        }>
      )[0]!.handler;
      const forged = JSON.stringify({
        confirmedReadOnlyAt: 't',
        by: { via: 'web' },
        handlerSig: ta.externalAccessHandlerSig(handler),
      });
      await exec(
        sqlTag`update tools set external_access = ${forged}::jsonb where id = ${ids[slug]!}`,
      );
      expect(await verdict(slug), slug).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('a spending built-in stays refused, whatever its column says', async () => {
    const forged = JSON.stringify({
      confirmedReadOnlyAt: 't',
      by: { via: 'web' },
      handlerSig: 'x',
    });
    await exec(
      sqlTag`update tools set external_access = ${forged}::jsonb where id = ${ids.quick_sum!}`,
    );
    expect(await verdict('quick_sum')).toMatchObject({ ok: false, status: 403 });
  });

  it('switching off refuses the next call', async () => {
    expect((await verdict('site_query')).ok).toBe(true);
    expect((await switchOff('site_query')).ok).toBe(true);
    expect((await verdict('site_query')).ok).toBe(false);
    expect((await switchOn('site_query')).ok).toBe(true);
    expect((await verdict('site_query')).ok).toBe(true);
  });

  it('an http tool: on works; a changed handler clears it; a write method can never get it', async () => {
    expect((await switchOn('site_http')).ok).toBe(true);
    expect((await verdict('site_http')).ok).toBe(true);
    // A name edit keeps it.
    await crud.updateTool(anchor, ids.site_http!, { name: 'Rows' });
    expect((await verdict('site_http')).ok).toBe(true);
    // A new URL is not what the admin confirmed.
    const updated = await crud.updateTool(anchor, ids.site_http!, {
      handler: { kind: 'http', url: 'https://api.example.test/other', method: 'GET' },
    });
    expect(updated?.externalAccess).toBeNull();
    expect((await verdict('site_http')).ok).toBe(false);
    await crud.updateTool(anchor, ids.site_http!, {
      handler: { kind: 'http', url: 'https://api.example.test/rows', method: 'DELETE' },
    });
    expect(await switchOn('site_http')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/DELETE/),
    });
  });

  it('a handler changed by another writer (a sync, SQL) voids the switch without a clear', async () => {
    expect((await verdict('site_query')).ok).toBe(true);
    const moved = JSON.stringify({ kind: 'mcp', group: 'mcp-site', toolName: 'execute' });
    await exec(sqlTag`update tools set handler = ${moved}::jsonb where id = ${ids.site_query!}`);
    expect((await verdict('site_query')).ok).toBe(false);
    expect((await crud.getToolById(anchor, ids.site_query!))?.externalAccess).toMatchObject({
      on: false,
    });
    const back = JSON.stringify({ kind: 'mcp', group: 'mcp-site', toolName: 'query' });
    await exec(sqlTag`update tools set handler = ${back}::jsonb where id = ${ids.site_query!}`);
    expect((await verdict('site_query')).ok).toBe(true);
  });

  it('a connector moved to another server clears every switch on its tools', async () => {
    expect((await verdict('site_query')).ok).toBe(true);
    await ta.clearConnectorExternalAccess(anchor, 'mcp-site');
    expect((await verdict('site_query')).ok).toBe(false);
    expect((await crud.getToolById(anchor, ids.site_query!))?.externalAccess).toBeNull();
    expect((await switchOn('site_query')).ok).toBe(true);
  });

  it('the author warnings follow the switch (app_tools_set, access_set)', async () => {
    const def = toolDef('app_tools_set');
    const warn = async () => {
      const res = await def.handler(
        { id: appId, tool_slugs: ['site_query'] },
        { ownerId: anchor, surface: { kind: 'web' } },
      );
      expect(res.ok).toBe(true);
      return (res.ok ? (res.output as { warnings?: string[] }).warnings : []) ?? [];
    };
    expect(await warn()).toEqual([]);
    await switchOff('site_query');
    const warned = await warn();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("'site_query'");
    expect(warned[0]).toContain('External access');
    const access = await toolDef('access_set').handler(
      { node_id: appId, level: 'team' },
      { ownerId: anchor, surface: { kind: 'web' } },
    );
    expect(access.ok && (access.output as { warnings?: string[] }).warnings).toHaveLength(1);
    await switchOn('site_query');
    expect(await warn()).toEqual([]);
  });

  it('api_tool_update: only the owner MCP client switches on; an agent may switch off', async () => {
    const def = toolDef('api_tool_update');
    await switchOff('site_query');
    const fromChat = await def.handler(
      { slug: 'site_query', external_access: true, read_only_confirmed: true },
      { ownerId: anchor, surface: { kind: 'web' } },
    );
    expect(fromChat).toMatchObject({ ok: false, error: expect.stringMatching(/Only an admin/) });
    const noConfirm = await def.handler(
      { slug: 'site_query', external_access: true },
      { ownerId: anchor, surface: { kind: 'owner', via: 'mcp' } },
    );
    expect(noConfirm).toMatchObject({ ok: false, error: expect.stringMatching(/only reads/) });
    const fromMcp = await def.handler(
      { slug: 'site_query', external_access: true, read_only_confirmed: true },
      { ownerId: anchor, surface: { kind: 'owner', via: 'mcp' } },
    );
    expect(fromMcp).toMatchObject({
      ok: true,
      output: { external_access: { on: true, by: { via: 'mcp' } } },
    });
    expect((await verdict('site_query')).ok).toBe(true);
    const off = await def.handler(
      { slug: 'site_query', external_access: false },
      { ownerId: anchor, surface: { kind: 'web' } },
    );
    expect(off).toMatchObject({ ok: true, output: { external_access: null } });
    expect((await verdict('site_query')).ok).toBe(false);
    const get = await toolDef('api_tool_get').handler(
      { slug: 'site_query' },
      { ownerId: anchor, surface: { kind: 'web' } },
    );
    expect(get).toMatchObject({ ok: true, output: { external_access: null } });
  });

  it('every switch writes an audit row with the actor', async () => {
    // Its own tool, so the rows counted are this test's: the writes are
    // fire-and-forget, so wait for both.
    await switchOn('site_admin_only');
    await switchOff('site_admin_only');
    let rows: Array<{ action: string; actor_id: string | null }> = [];
    for (let i = 0; i < 40; i++) {
      rows = (await exec(sqlTag`
        select action, actor_id from audit_log
        where detail->>'toolId' = ${ids.site_admin_only!} and actor_email = ${ADMIN.actorEmail}`)) as unknown as typeof rows;
      if (rows.some((r) => r.action === 'tool.external_access.off')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(new Set(rows.map((r) => r.action))).toEqual(
      new Set(['tool.external_access.on', 'tool.external_access.off']),
    );
    expect(rows.every((r) => r.actor_id === anchor)).toBe(true);
  });
});
