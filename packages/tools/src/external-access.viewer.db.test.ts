/**
 * "External access" on a real, migrated Postgres (external-access.ts,
 * docs/member-logins.md "External access: outside tools in shared apps").
 * The remote MCP server is a fake: `mcpCallRemoteTool` is stood in, so no
 * connector or site data is ever reached. Proves: an http tool is refused
 * until an admin switches External access on with the read-only
 * confirmation, then needs the app's declaration and nothing else. A
 * CONNECTOR tool (team apps Phase 2) is allowed by its connector's level
 * (the connector the handler names): team for a member's run, client for a
 * client app, public for a contact link; the switch is its READ-ONLY MARK
 * (on = a read, off = a write, which an app may make). It runs under the
 * caller's role; a disabled connector refuses; confirm-gated, shell and
 * recipe tools never pass, nor any built-in on a link; a changed handler or
 * a moved connector voids the mark; the author warnings follow the level;
 * only the owner's MCP client may switch it on through `api_tool_update`;
 * each switch writes an audit row with the actor.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/external-access.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  calls: [] as Array<{ toolName: string; args: Record<string, unknown> }>,
  // What the remote server lists on a sync (access matrix N4 test).
  remote: [] as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
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
  mcpListRemoteTools: vi.fn(async () => ({ tools: fake.remote, serverInfo: undefined })),
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

  const setConnectorLevel = (lvl: string) =>
    exec(sqlTag`update tool_groups set audience = ${lvl}
      where owner_id = ${anchor} and slug = 'mcp-site'`);

  it('a connector tool at team level without the mark: a member app may call it, as a write', async () => {
    expect(await verdict('site_query')).toMatchObject({ ok: true, write: true });
  });

  it('will not switch on without the read-only confirmation', async () => {
    const res = await ta.setToolExternalAccess(anchor, ids.site_query!, { allow: true, by: ADMIN });
    expect(res).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringMatching(/only reads/),
    });
    expect(await verdict('site_query')).toMatchObject({ ok: true, write: true });
  });

  it('on + declared: a member may call it, and it runs under the team role', async () => {
    const res = await switchOn('site_query');
    expect(res.ok).toBe(true);
    const v = await verdict('site_query');
    if (!v.ok) throw new Error(v.reason);
    expect(v.write).toBe(false);
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

  it('the connector the handler names decides, not a group that lists the tool; at admin it is refused, marked or not', async () => {
    // site_admin_only is listed only in an admin-level group, but its
    // handler names the team-level connector.
    expect((await switchOn('site_admin_only')).ok).toBe(true);
    expect(await verdict('site_admin_only')).toMatchObject({ ok: true, write: false });
    await setConnectorLevel('admin');
    try {
      for (const slug of ['site_query', 'site_admin_only']) {
        expect(await verdict(slug), slug).toMatchObject({
          ok: false,
          status: 403,
          reason: expect.stringMatching(/connector at admin level/),
        });
      }
    } finally {
      await setConnectorLevel('team');
    }
  });

  it('its connector switched off: the call is refused (dispatch reads the connector each call)', async () => {
    await exec(
      sqlTag`update tool_groups set enabled = false where owner_id = ${anchor} and slug = 'mcp-site'`,
    );
    try {
      expect(await verdict('site_query')).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/is off or not set up/),
      });
      // And dispatch itself still reads the connector on each call.
      const [row] = (await exec(
        sqlTag`select * from tools where id = ${ids.site_query!}`,
      )) as unknown as Array<Record<string, unknown>>;
      fake.calls.length = 0;
      const out = await m.withViewer('team', () =>
        dispatch.dispatchTool(
          {
            ...(row as unknown as import('@mantle/db').Tool),
            slug: 'site_query',
            requiresConfirm: false,
            handler: { kind: 'mcp', group: 'mcp-site', toolName: 'query' },
          },
          {},
          { ownerId: anchor, surface: { kind: 'team' } },
        ),
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

  it('a client-level app: only a connector at client level, under the client role', async () => {
    expect(await level.appToolVerdict('client', anchor, DECLARED, 'site_query')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/connector at team level/),
    });
    await setConnectorLevel('client');
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
    // Mark off: still allowed, as a write; a built-in off the client list
    // stays refused.
    await switchOff('site_query');
    try {
      expect(await level.appToolVerdict('client', anchor, DECLARED, 'site_query')).toMatchObject({
        ok: true,
        write: true,
      });
      expect(await level.appToolVerdict('client', anchor, DECLARED, 'quick_sum')).toMatchObject({
        ok: false,
        status: 403,
      });
    } finally {
      await switchOn('site_query');
      await setConnectorLevel('team');
    }
  });

  it('a contact link: a connector at public level, an http tool with the switch on, never a built-in', async () => {
    expect(await ta.contactAppToolVerdict(anchor, DECLARED, 'site_query')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/connector at team level/),
    });
    await setConnectorLevel('public');
    const v = await ta.contactAppToolVerdict(anchor, DECLARED, 'site_query');
    // Contacts read only (Jason, 2026-10-08): an unmarked tool on a public
    // connector is refused on a link.
    await switchOff('site_query');
    const unmarked = await ta.contactAppToolVerdict(anchor, DECLARED, 'site_query');
    await switchOn('site_query');
    expect(unmarked).toMatchObject({
      ok: false,
      status: 403,
      reason: expect.stringMatching(/marked read-only/),
    });
    if (!v.ok) throw new Error(v.reason);
    fake.calls.length = 0;
    // The dispatch holds the connector's level too (M2 audit, low 6): the
    // call runs while the connector is still at public level.
    const fresh = await (await import('./resolve')).resolveTool(anchor, 'site_query');
    let out: Awaited<ReturnType<typeof dispatch.dispatchTool>>;
    try {
      out = await m.withViewer('public', () =>
        dispatch.dispatchTool(
          fresh ?? v.tool,
          { q: 'l' },
          {
            ownerId: anchor,
            surface: { kind: 'contact', contactId: randomUUID(), shareId: randomUUID() },
          },
        ),
      );
    } finally {
      await setConnectorLevel('team');
    }
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

  it('dispatch itself holds the level and the public read-only rule on every non-owner call', async () => {
    const [row] = (await exec(
      sqlTag`select id from tools where id = ${ids.site_query!}`,
    )) as unknown as { id: string }[];
    expect(row).toBeTruthy();
    const tool = await (await import('./resolve')).resolveTool(anchor, 'site_query');
    if (!tool) throw new Error('no tool');
    // A member's chat turn through some other group: the connector's own
    // level decides (M2 audit, low 6).
    await setConnectorLevel('admin');
    try {
      fake.calls.length = 0;
      const chat = await m.withViewer('team', () =>
        dispatch.dispatchTool(tool, {}, { ownerId: anchor, surface: { kind: 'team' } }),
      );
      expect(chat).toMatchObject({
        ok: false,
        error: expect.stringMatching(/not open at your level/),
      });
      // The owner's own path is never gated.
      const owner = await dispatch.dispatchTool(
        tool,
        {},
        {
          ownerId: anchor,
          surface: { kind: 'owner', via: 'mcp' },
        },
      );
      expect(owner.ok).toBe(true);
    } finally {
      await setConnectorLevel('team');
    }
    // A public run (a public agent, a contact link) only reads.
    await setConnectorLevel('public');
    await switchOff('site_query');
    try {
      const unmarked = await crud.getToolById(anchor, ids.site_query!);
      expect(unmarked).toBeTruthy();
      const fresh = await (await import('./resolve')).resolveTool(anchor, 'site_query');
      const pub = await m.withViewer('public', () =>
        dispatch.dispatchTool(fresh!, {}, { ownerId: anchor, surface: { kind: 'web' } }),
      );
      expect(pub).toMatchObject({ ok: false, error: expect.stringMatching(/marked read-only/) });
    } finally {
      await switchOn('site_query');
      await setConnectorLevel('team');
    }
  });

  it("switching a connector tool's mark off turns its next call into a write", async () => {
    expect(await verdict('site_query')).toMatchObject({ ok: true, write: false });
    expect((await switchOff('site_query')).ok).toBe(true);
    expect(await verdict('site_query')).toMatchObject({ ok: true, write: true });
    expect((await switchOn('site_query')).ok).toBe(true);
    expect(await verdict('site_query')).toMatchObject({ ok: true, write: false });
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

  it('a handler changed by another writer (a sync, SQL) voids the mark: refused, never a write', async () => {
    expect(await verdict('site_query')).toMatchObject({ ok: true, write: false });
    const moved = JSON.stringify({ kind: 'mcp', group: 'mcp-site', toolName: 'execute' });
    await exec(sqlTag`update tools set handler = ${moved}::jsonb where id = ${ids.site_query!}`);
    expect(await verdict('site_query')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/changed after an admin marked it/),
    });
    expect((await crud.getToolById(anchor, ids.site_query!))?.externalAccess).toMatchObject({
      on: false,
    });
    const back = JSON.stringify({ kind: 'mcp', group: 'mcp-site', toolName: 'query' });
    await exec(sqlTag`update tools set handler = ${back}::jsonb where id = ${ids.site_query!}`);
    expect(await verdict('site_query')).toMatchObject({ ok: true, write: false });
  });

  it('a connector moved to another server voids every mark (refused, never a write) and disables its write tools below admin', async () => {
    expect(await verdict('site_query')).toMatchObject({ ok: true, write: false });
    await ta.clearConnectorExternalAccess(anchor, 'mcp-site');
    expect(await verdict('site_query')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/changed after an admin marked it/),
    });
    expect((await crud.getToolById(anchor, ids.site_query!))?.externalAccess).toMatchObject({
      on: false,
    });
    // site_confirm was never marked: on a team-level connector it is now off.
    const [confirmRow] = (await exec(
      sqlTag`select enabled from tools where id = ${ids.site_confirm!}`,
    )) as unknown as { enabled: boolean }[];
    expect(confirmRow?.enabled).toBe(false);
    await exec(sqlTag`update tools set enabled = true where id = ${ids.site_confirm!}`);
    expect((await switchOn('site_query')).ok).toBe(true);
  });

  it("the author warnings follow the connector's level (app_tools_set, access_set)", async () => {
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
    await setConnectorLevel('admin');
    try {
      const warned = await warn();
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("'site_query'");
      expect(warned[0]).toContain('connector at admin level');
      const access = await toolDef('access_set').handler(
        { node_id: appId, level: 'team' },
        { ownerId: anchor, surface: { kind: 'web' } },
      );
      expect(access.ok && (access.output as { warnings?: string[] }).warnings).toHaveLength(1);
    } finally {
      await setConnectorLevel('team');
    }
    expect(await warn()).toEqual([]);
  });

  // Access matrix N5: an agent turning a closed connector tool back on, or
  // clearing its confirm, below admin waits for the owner.
  it('api_tool_update: an agent re-opening a connector tool below admin goes to Pending', async () => {
    const def = toolDef('api_tool_update');
    const agentCtx = {
      ownerId: anchor,
      surface: { kind: 'web' as const },
      agent: { slug: 'some-agent', name: 'Some agent' },
    } as never;
    await exec(sqlTag`update tools set enabled = false where id = ${ids.site_query!}`);
    try {
      const queued = await def.handler({ slug: 'site_query', enabled: true }, agentCtx);
      expect(queued).toMatchObject({ ok: true, output: { status: 'queued_for_approval' } });
      const [still] = (await exec(
        sqlTag`select enabled from tools where id = ${ids.site_query!}`,
      )) as unknown as { enabled: boolean }[];
      expect(still?.enabled).toBe(false);
      const unconfirm = await def.handler(
        { slug: 'site_confirm', requires_confirm: false },
        agentCtx,
      );
      expect(unconfirm).toMatchObject({ ok: true, output: { status: 'queued_for_approval' } });
      // The owner (no agent): applied at once.
      const owner = await def.handler(
        { slug: 'site_query', enabled: true },
        { ownerId: anchor, surface: { kind: 'web' } },
      );
      expect(owner.ok).toBe(true);
      const [on] = (await exec(
        sqlTag`select enabled from tools where id = ${ids.site_query!}`,
      )) as unknown as { enabled: boolean }[];
      expect(on?.enabled).toBe(true);
    } finally {
      await exec(sqlTag`update tools set enabled = true where id = ${ids.site_query!}`);
      await exec(sqlTag`delete from pending_tool_calls where owner_id = ${anchor}`);
    }
  });

  // M4 audit, medium 1: an agent lowering a whole connector waits for the
  // owner too; raising it (the safe way) and the owner's own change apply.
  it('access_set: an agent lowering a connector goes to Pending; raising and the owner apply', async () => {
    const def = toolDef('access_set');
    const agentCtx = {
      ownerId: anchor,
      surface: { kind: 'web' as const },
      agent: { slug: 'some-agent', name: 'Some agent' },
    } as never;
    const level = async () => {
      const [g] = (await exec(sqlTag`
        select audience from tool_groups where owner_id = ${anchor} and slug = 'mcp-site'`)) as unknown as {
        audience: string;
      }[];
      return g?.audience;
    };
    await setConnectorLevel('admin');
    try {
      const queued = await def.handler({ tool_group_slug: 'mcp-site', level: 'team' }, agentCtx);
      expect(queued).toMatchObject({ ok: true, output: { status: 'queued_for_approval' } });
      expect(await level()).toBe('admin');
      const [row] = (await exec(sqlTag`
        select tool_slug, args from pending_tool_calls where owner_id = ${anchor}
        order by created_at desc limit 1`)) as unknown as {
        tool_slug: string;
        args: Record<string, unknown>;
      }[];
      expect(row).toMatchObject({
        tool_slug: 'access_set',
        args: { tool_group_slug: 'mcp-site', level: 'team' },
      });
      // The owner (no agent): applied at once.
      const owner = await def.handler(
        { tool_group_slug: 'mcp-site', level: 'team' },
        { ownerId: anchor, surface: { kind: 'web' } },
      );
      expect(owner.ok).toBe(true);
      expect(await level()).toBe('team');
      // Raising is the safe way: an agent may.
      const raised = await def.handler({ tool_group_slug: 'mcp-site', level: 'admin' }, agentCtx);
      expect(raised.ok && (raised.output as { status?: string }).status).not.toBe(
        'queued_for_approval',
      );
      expect(await level()).toBe('admin');
    } finally {
      await setConnectorLevel('team');
      await exec(sqlTag`delete from pending_tool_calls where owner_id = ${anchor}`);
    }
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
    expect(await verdict('site_query')).toMatchObject({ ok: true, write: false });
    const off = await def.handler(
      { slug: 'site_query', external_access: false },
      { ownerId: anchor, surface: { kind: 'web' } },
    );
    expect(off).toMatchObject({ ok: true, output: { external_access: null } });
    expect(await verdict('site_query')).toMatchObject({ ok: true, write: true });
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

  // Access matrix N4: a read-only mark is for the tool the admin looked at.
  it('a sync voids the mark when the remote tool changes, and a returning tool stays off below admin', async () => {
    const { syncMcpConnector } = await import('./mcp-sync');
    type Live = { slug: string; description: string; input_schema: Record<string, unknown> };
    const live = (await exec(sqlTag`
      select slug, description, input_schema from tools
      where owner_id = ${anchor} and handler->>'group' = 'mcp-site'`)) as unknown as Live[];
    const nameOf: Record<string, string> = {
      site_query: 'query',
      site_admin_only: 'other',
      site_confirm: 'confirmed',
    };
    const same = live.map((t) => ({
      name: nameOf[t.slug]!,
      description: t.description,
      inputSchema: t.input_schema,
    }));
    // From the raw row: getToolById hands back a summary, which drops the
    // mark's signature.
    const state = async () => {
      const [r] = (await exec(sqlTag`
        select slug, handler, requires_confirm as "requiresConfirm",
          external_access as "externalAccess", description, input_schema as "inputSchema"
        from tools where id = ${ids.site_query!}`)) as unknown as Parameters<
        typeof ta.connectorMarkState
      >[0][];
      return ta.connectorMarkState(r!);
    };
    const enabled = async () => {
      const [r] = (await exec(
        sqlTag`select enabled from tools where id = ${ids.site_query!}`,
      )) as unknown as { enabled: boolean }[];
      return r?.enabled;
    };
    try {
      // A first sync settles the seeded rows to what the server lists (the
      // sync's own schema shape); a mark is taken on that.
      fake.remote = same;
      await syncMcpConnector(anchor, 'mcp-site');
      expect((await switchOn('site_query')).ok).toBe(true);
      await syncMcpConnector(anchor, 'mcp-site');
      expect(await state()).toBe('read');

      // The remote server adds a parameter: the mark stops counting.
      fake.remote = same.map((t) =>
        t.name === 'query'
          ? { ...t, inputSchema: { type: 'object', properties: { sql: { type: 'string' } } } }
          : t,
      );
      await syncMcpConnector(anchor, 'mcp-site');
      expect(await state()).toBe('stale');

      // Marked again, then the tool vanishes and comes back: off, mark void.
      expect((await switchOn('site_query')).ok).toBe(true);
      fake.remote = same.filter((t) => t.name !== 'query');
      await syncMcpConnector(anchor, 'mcp-site');
      expect(await enabled()).toBe(false);
      fake.remote = same;
      await syncMcpConnector(anchor, 'mcp-site');
      expect(await enabled()).toBe(false);
      expect(await state()).toBe('stale');
    } finally {
      fake.remote = same;
      await exec(sqlTag`
        update tools set enabled = true, description = ${live.find((t) => t.slug === 'site_query')!.description},
          input_schema = ${JSON.stringify(live.find((t) => t.slug === 'site_query')!.input_schema)}::jsonb,
          handler = ${JSON.stringify({ kind: 'mcp', group: 'mcp-site', toolName: 'query' })}::jsonb
        where id = ${ids.site_query!}`);
      await switchOn('site_query');
    }
  });
});
