/**
 * "External access" on a real, migrated Postgres (external-access.ts,
 * docs/member-logins.md "External access: outside tools in shared apps").
 * The remote MCP server is a fake: `mcpCallRemoteTool` is stood in, so no
 * connector or site data is ever reached. Proves: an http tool is refused
 * until an admin switches External access on with the read-only
 * confirmation, then needs the app's declaration and nothing else. A
 * CONNECTOR tool (team apps Phase 2; W5b2) is allowed by the workspaces that
 * hold its connector (the connector the handler names), never its level: a
 * member's run without a login by Team, a login's run by the login's
 * workspaces, and a contact link never (a link holds no workspace); the
 * switch is its READ-ONLY MARK (on = a read, off = a write, which needs the
 * connector's Write tick and a Moderator). An app run reads in the app's
 * workspace scope, as the broker runs it; a non-owner call outside a
 * workspace scope takes its rule from its surface (a member's login, a
 * link); a disabled connector refuses; confirm-gated, shell and recipe tools never
 * pass, nor any built-in on a link; a changed handler or a moved connector
 * voids the mark; the author warnings follow the workspaces;
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
  // A member (a Moderator of Team) and a second member (a user of Clients),
  // and the brain's workspaces: Team holds the connector with Write on,
  // Clients with Write off (W5b2: the workspaces decide, not the connector's
  // level).
  const member = randomUUID();
  const clientsMember = randomUUID();
  const ws = { admin: randomUUID(), team: randomUUID(), clients: randomUUID() };
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
    // The lookup's inputs, as a remote server lists them: a mark is for these.
    await exec(sqlTag`
      update tools set input_schema = '{"type":"object","properties":{"q":{"type":"string"}}}'::jsonb
      where owner_id = ${anchor} and slug = 'site_query'`);
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
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member'),
        (${clientsMember}, ${`${tag}-c@example.invalid`}, 'x', 'member')`);
    await exec(sqlTag`
      insert into workspaces (id, owner_id, name, is_admin, bridge_key) values
        (${ws.admin}, ${anchor}, 'Admin', true, 'admin'),
        (${ws.team}, ${anchor}, 'Team', false, null),
        (${ws.clients}, ${anchor}, ${`${tag} Clients`}, false, null)`);
    await exec(sqlTag`
      insert into workspace_users (workspace_id, login_id, moderator) values
        (${ws.team}, ${member}, true), (${ws.clients}, ${clientsMember}, false)`);
    await exec(sqlTag`
      insert into workspace_resources (workspace_id, type, ref_id, write) values
        (${ws.admin}, 'connector', 'mcp-site', true),
        (${ws.team}, 'connector', 'mcp-site', true),
        (${ws.clients}, 'connector', 'mcp-site', false)`);
  }, 60_000);

  afterAll(async () => {
    await exec(sqlTag`
      delete from audit_log where detail->>'toolId' in
        (select id::text from tools where owner_id = ${anchor})`);
    await exec(sqlTag`delete from tool_groups where owner_id = ${anchor}`);
    await exec(sqlTag`delete from tools where owner_id = ${anchor}`);
    await exec(sqlTag`delete from nodes where owner_id = ${anchor}`);
    await exec(sqlTag`delete from workspaces where owner_id = ${anchor}`);
    await exec(sqlTag`delete from spaces where login_id = ${anchor}`);
    await exec(sqlTag`delete from auth.users where id in (${anchor}, ${member}, ${clientsMember})`);
    await m.closeDb();
  }, 60_000);

  /** Take the connector off a workspace for the length of `fn`. */
  const without = async (wsId: string, fn: () => Promise<void>) => {
    await exec(sqlTag`delete from workspace_resources
      where workspace_id = ${wsId} and type = 'connector' and ref_id = 'mcp-site'`);
    try {
      await fn();
    } finally {
      await exec(sqlTag`insert into workspace_resources (workspace_id, type, ref_id, write)
        values (${wsId}, 'connector', 'mcp-site', ${wsId !== ws.clients})
        on conflict (workspace_id, type, ref_id) do nothing`);
    }
  };
  const setConnectorLevel = (lvl: string) =>
    exec(sqlTag`update tool_groups set audience = ${lvl}
      where owner_id = ${anchor} and slug = 'mcp-site'`);

  it('a connector tool Team holds with Write on, without the mark: a member app may call it, as a write', async () => {
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

  it('on + declared: a member may call it, in the app run’s workspace scope', async () => {
    const res = await switchOn('site_query');
    expect(res.ok).toBe(true);
    const v = await verdict('site_query');
    if (!v.ok) throw new Error(v.reason);
    expect(v.write).toBe(false);
    const scope = level.appToolScope('team', { loginId: member, name: 'A member' }, { team: true });
    expect(scope).toMatchObject({ viewer: 'team', surface: { kind: 'team', privateReads: false } });
    fake.calls.length = 0;
    // In the member's workspace scope (W8c: no level role). The app-run
    // form ({ team: true }) reads the brain's own Team workspace, which this
    // fixture's owner is not.
    const out = await m.withViewer({ login: member }, () =>
      dispatch.dispatchTool(v.tool, { q: 'x' }, { ownerId: anchor, surface: scope.surface }),
    );
    expect(out).toMatchObject({ ok: true, output: { rows: [{ n: 1 }] }, untrusted: true });
    expect(fake.calls).toEqual([{ toolName: 'query', args: { q: 'x' } }]);
  });

  it('still needs the declaration', async () => {
    expect(await verdict('site_query', ['site_http'])).toMatchObject({ ok: false, status: 403 });
  });

  it('the connector the handler names decides, not a group that lists the tool; off Team it is refused, marked or not, whatever its level', async () => {
    // site_admin_only is listed only in an admin-level group, but its
    // handler names the connector Team holds.
    expect((await switchOn('site_admin_only')).ok).toBe(true);
    expect(await verdict('site_admin_only')).toMatchObject({ ok: true, write: false });
    await without(ws.team, async () => {
      // Its level says team: the level no longer opens it (W5b2).
      for (const slug of ['site_query', 'site_admin_only']) {
        expect(await verdict(slug), slug).toMatchObject({
          ok: false,
          status: 403,
          reason: expect.stringMatching(/Team workspace does not hold/),
        });
      }
    });
    // And its level does not close it either.
    await setConnectorLevel('admin');
    try {
      expect(await verdict('site_admin_only')).toMatchObject({ ok: true, write: false });
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
      const out = await dispatch.dispatchTool(
        {
          ...(row as unknown as import('@mantle/db').Tool),
          slug: 'site_query',
          requiresConfirm: false,
          handler: { kind: 'mcp', group: 'mcp-site', toolName: 'query' },
        },
        {},
        { ownerId: anchor, surface: { kind: 'team' } },
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

  it('an app run: every workspace that holds the app must hold the connector (R2)', async () => {
    const check = { appId };
    // Grant writes take the item's head (0244).
    const grants = (q: ReturnType<typeof sqlTag>) =>
      m.withHeads([appId], 'update', (tx) => tx.execute(q));
    const run = () => level.appToolVerdict('team', anchor, DECLARED, 'site_query', member, check);
    // The app is in no workspace: no connector.
    expect(await run()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/app is in no workspace/),
    });
    await grants(sqlTag`insert into item_grants (node_id, workspace_id, write, is_home)
      values (${appId}, ${ws.team}, false, true)`);
    try {
      expect(await run()).toMatchObject({ ok: true, write: false });
      // A second holder without the connector: refused.
      await without(ws.clients, async () => {
        await grants(sqlTag`insert into item_grants (node_id, workspace_id, write)
          values (${appId}, ${ws.clients}, false)`);
        expect(await run()).toMatchObject({
          ok: false,
          reason: expect.stringMatching(/every workspace that holds this app/),
        });
      });
      // Held by both, but Clients without Write: a write is refused.
      await switchOff('site_query');
      expect(await run()).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/Write switched on in every workspace/),
      });
    } finally {
      await switchOn('site_query');
      await grants(sqlTag`delete from item_grants where node_id = ${appId}`);
    }
  });

  it('a contact link: no connector tool (a link holds no workspace), an http tool with the switch on, never a built-in', async () => {
    // Whatever the connector's level, marked or not.
    await setConnectorLevel('public');
    try {
      expect(await ta.contactAppToolVerdict(anchor, DECLARED, 'site_query')).toMatchObject({
        ok: false,
        status: 403,
        reason: expect.stringMatching(/holds no workspace/),
      });
      fake.calls.length = 0;
      // The dispatch holds it too (M2 audit, low 6).
      const fresh = await (await import('./resolve')).resolveTool(anchor, 'site_query');
      const out = await dispatch.dispatchTool(
        fresh!,
        { q: 'l' },
        {
          ownerId: anchor,
          surface: { kind: 'contact', contactId: randomUUID(), shareId: randomUUID() },
        },
      );
      expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/holds no workspace/) });
      expect(fake.calls).toEqual([]);
    } finally {
      await setConnectorLevel('team');
    }
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

  it('dispatch itself holds the workspace rule and the link read-only rule on every non-owner call', async () => {
    const [row] = (await exec(
      sqlTag`select id from tools where id = ${ids.site_query!}`,
    )) as unknown as { id: string }[];
    expect(row).toBeTruthy();
    const tool = await (await import('./resolve')).resolveTool(anchor, 'site_query');
    if (!tool) throw new Error('no tool');
    // A member's call through some other group: the workspaces that hold
    // the connector decide (M2 audit, low 6; W5b2), never its level.
    const asLogin = (loginId?: string) =>
      dispatch.dispatchTool(
        tool,
        {},
        { ownerId: anchor, surface: { kind: 'team', ...(loginId ? { loginId } : {}) } },
      );
    fake.calls.length = 0;
    expect(await asLogin(member)).toMatchObject({ ok: true });
    expect(await asLogin()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/signed-in user of a workspace/),
    });
    await without(ws.team, async () => {
      expect(await asLogin(member)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/not a resource of any of your workspaces/),
      });
    });
    expect(fake.calls).toHaveLength(1);
    await setConnectorLevel('admin');
    try {
      fake.calls.length = 0;
      // The level does not close it to the member either.
      expect(await asLogin(member)).toMatchObject({ ok: true });
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
    // A link's call only reads, whatever else holds (the public agent and
    // its level scope went in W8c; a link is what is left below a member).
    await switchOff('site_query');
    try {
      const unmarked = await crud.getToolById(anchor, ids.site_query!);
      expect(unmarked).toBeTruthy();
      const fresh = await (await import('./resolve')).resolveTool(anchor, 'site_query');
      fake.calls.length = 0;
      const pub = await dispatch.dispatchTool(
        fresh!,
        {},
        {
          ownerId: anchor,
          surface: { kind: 'contact', contactId: randomUUID(), shareId: randomUUID() },
        },
      );
      expect(pub).toMatchObject({ ok: false, error: expect.stringMatching(/marked read-only/) });
      expect(fake.calls).toEqual([]);
    } finally {
      await switchOn('site_query');
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

  it('a connector moved to another server voids every mark (refused, never a write) and disables its write tools beyond Admin', async () => {
    expect(await verdict('site_query')).toMatchObject({ ok: true, write: false });
    await ta.clearConnectorExternalAccess(anchor, 'mcp-site');
    expect(await verdict('site_query')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/changed after an admin marked it/),
    });
    expect((await crud.getToolById(anchor, ids.site_query!))?.externalAccess).toMatchObject({
      on: false,
    });
    // site_confirm was never marked: on a connector Team holds it is now off.
    const [confirmRow] = (await exec(
      sqlTag`select enabled from tools where id = ${ids.site_confirm!}`,
    )) as unknown as { enabled: boolean }[];
    expect(confirmRow?.enabled).toBe(false);
    await exec(sqlTag`update tools set enabled = true where id = ${ids.site_confirm!}`);
    expect((await switchOn('site_query')).ok).toBe(true);
  });

  it('the author warnings follow the workspaces that hold the connector (app_tools_set)', async () => {
    const def = toolDef('app_tools_set');
    const warn = async () => {
      const res = await def.handler(
        { id: appId, tool_slugs: ['site_query'] },
        { ownerId: anchor, surface: { kind: 'web' } },
      );
      expect(res.ok).toBe(true);
      return (res.ok ? (res.output as { warnings?: string[] }).warnings : []) ?? [];
    };
    // The team rules run only for an app a workspace other than Admin holds
    // (R2): held by Admin alone, the app keeps the runner's rules and warns
    // nothing, whoever holds the connector.
    await without(ws.team, async () => {
      expect(await warn()).toEqual([]);
    });
    // Grant writes take the item's head (0244).
    const grants = (q: ReturnType<typeof sqlTag>) =>
      m.withHeads([appId], 'update', (tx) => tx.execute(q));
    await grants(sqlTag`insert into item_grants (node_id, workspace_id, write, is_home)
      values (${appId}, ${ws.team}, false, true)`);
    try {
      expect(await warn()).toEqual([]);
      await without(ws.team, async () => {
        const warned = await warn();
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain("'site_query'");
        expect(warned[0]).toContain('Team workspace does not hold');
      });
      expect(await warn()).toEqual([]);
    } finally {
      await grants(sqlTag`delete from item_grants where node_id = ${appId}`);
    }
  });

  // Access matrix N5: an agent turning a closed connector tool back on, or
  // clearing its confirm, below admin waits for the owner.
  it('api_tool_update: an agent re-opening a connector tool beyond Admin goes to Pending', async () => {
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

  // Access matrix T9: an API key or a peer acting as the owner never opens a
  // connector (turning a tool on, clearing its confirm), as it never switches
  // External access on. The owner's own paths apply. (A connector's level
  // went in W7b: access_set changes none.)
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
  it('a sync voids the mark when the remote tool changes, and a returning tool stays off beyond Admin', async () => {
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

  // Access matrix T6: the remote server can add a parameter (one that
  // writes) long before a sync voids the mark; below the owner a marked tool
  // takes only the inputs it was marked with.
  it('a marked connector tool takes only the inputs it was marked with, below the owner', async () => {
    const { resolveTool } = await import('./resolve');
    await switchOn('site_query');
    const tool = await resolveTool(anchor, 'site_query');
    if (!tool) throw new Error('no tool');
    const surface = { kind: 'team' as const, loginId: member };
    const asMember = (input: Record<string, unknown>) =>
      dispatch.dispatchTool(tool, input, { ownerId: anchor, surface });
    fake.calls.length = 0;
    expect(await asMember({ q: 'x' })).toMatchObject({ ok: true });
    const extra = await asMember({ q: 'x', statement: 'delete from rows' });
    expect(extra).toMatchObject({
      ok: false,
      error: expect.stringMatching(/'statement' is not one of them/),
    });
    expect(fake.calls).toEqual([{ toolName: 'query', args: { q: 'x' } }]);
    // The owner's own path is never gated.
    const owner = await dispatch.dispatchTool(
      tool,
      { q: 'x', statement: 'select 1' },
      { ownerId: anchor, surface: { kind: 'owner', via: 'mcp' } },
    );
    expect(owner.ok).toBe(true);
    // An unmarked tool is a write anyway: a Moderator of a workspace that
    // holds the connector with Write on may make it with any input.
    await switchOff('site_query');
    try {
      const fresh = await resolveTool(anchor, 'site_query');
      const write = await dispatch.dispatchTool(
        fresh!,
        { q: 'x', statement: 'select 1' },
        { ownerId: anchor, surface },
      );
      expect(write.ok).toBe(true);
    } finally {
      await switchOn('site_query');
    }
    // An open schema counts as closed below the owner, and one level down an
    // object input takes only the keys it lists (audit B2).
    expect(
      dispatch.undeclaredToolArgs({ type: 'object', additionalProperties: true }, { a: 1 }),
    ).toEqual(['a']);
    expect(dispatch.undeclaredToolArgs({ type: 'object' }, { a: 1, b: undefined })).toEqual(['a']);
    expect(
      dispatch.undeclaredToolArgs(
        {
          type: 'object',
          additionalProperties: true,
          properties: { filter: { type: 'object', properties: { name: {} } } },
        },
        { filter: { name: 'x', run_sql: 'drop' } },
      ),
    ).toEqual(['filter.run_sql']);
  });

  it('a connector tool synced without its list of inputs cannot be marked read-only (B2)', async () => {
    const [big] = (await exec(sqlTag`
      insert into tools (owner_id, slug, name, description, handler, input_schema)
      values (${anchor}, 'site_big', 'n', 'd',
        ${JSON.stringify({ kind: 'mcp', group: 'mcp-site', toolName: 'big' })}::jsonb,
        '{"type":"object","additionalProperties":true}'::jsonb)
      returning id`)) as unknown as Array<{ id: string }>;
    try {
      const res = await ta.setToolExternalAccess(anchor, big!.id, {
        allow: true,
        readOnlyConfirmed: true,
        by: ADMIN,
      });
      expect(res).toMatchObject({ ok: false, status: 400 });
      expect(res.ok === false && res.error).toMatch(/without its list of inputs/);
    } finally {
      await exec(sqlTag`delete from tools where id = ${big!.id}`);
    }
  });

  // Access matrix T8: the N5 gate covers an http tool with External access
  // too. Switching it off (or adding a confirm) is how an admin closes it to
  // shared apps; an agent reopening it waits for the owner.
  it('api_tool_update: an agent reopening an http tool with External access goes to Pending', async () => {
    const def = toolDef('api_tool_update');
    const agentCtx = {
      ownerId: anchor,
      surface: { kind: 'web' as const },
      agent: { slug: 'some-agent', name: 'Some agent' },
    } as never;
    const state = async () => {
      const [r] = (await exec(sqlTag`
        select enabled, requires_confirm from tools where id = ${ids.site_http!}`)) as unknown as {
        enabled: boolean;
        requires_confirm: boolean;
      }[];
      return r;
    };
    // An earlier test leaves it on DELETE, which can never get the switch.
    await exec(sqlTag`
      update tools set handler = ${JSON.stringify({
        kind: 'http',
        url: 'https://api.example.test/rows',
        method: 'GET',
      })}::jsonb
      where id = ${ids.site_http!}`);
    expect((await switchOn('site_http')).ok).toBe(true);
    await exec(sqlTag`update tools set enabled = false where id = ${ids.site_http!}`);
    try {
      const queued = await def.handler({ slug: 'site_http', enabled: true }, agentCtx);
      expect(queued).toMatchObject({ ok: true, output: { status: 'queued_for_approval' } });
      expect((await state())?.enabled).toBe(false);
      // A confirm added to close it: removing it waits too.
      await exec(sqlTag`
        update tools set enabled = true, requires_confirm = true where id = ${ids.site_http!}`);
      const unconfirm = await def.handler({ slug: 'site_http', requires_confirm: false }, agentCtx);
      expect(unconfirm).toMatchObject({ ok: true, output: { status: 'queued_for_approval' } });
      expect((await state())?.requires_confirm).toBe(true);
      // Closing stays open to an agent, and the owner applies at once.
      await exec(sqlTag`update tools set requires_confirm = false where id = ${ids.site_http!}`);
      const off = await def.handler({ slug: 'site_http', enabled: false }, agentCtx);
      expect(off.ok && (off.output as { status?: string }).status).not.toBe('queued_for_approval');
      expect((await state())?.enabled).toBe(false);
      const owner = await def.handler(
        { slug: 'site_http', enabled: true },
        { ownerId: anchor, surface: { kind: 'web' } },
      );
      expect(owner.ok).toBe(true);
      expect((await state())?.enabled).toBe(true);
      // Without External access an agent may turn it on, as before.
      await switchOff('site_http');
      await exec(sqlTag`update tools set enabled = false where id = ${ids.site_http!}`);
      const plain = await def.handler({ slug: 'site_http', enabled: true }, agentCtx);
      expect(plain.ok && (plain.output as { status?: string }).status).not.toBe(
        'queued_for_approval',
      );
      expect((await state())?.enabled).toBe(true);
    } finally {
      await exec(sqlTag`
        update tools set enabled = true, requires_confirm = false where id = ${ids.site_http!}`);
      await exec(sqlTag`delete from pending_tool_calls where owner_id = ${anchor}`);
    }
  });

  // Access matrix T7: a new key under the same vault entry voids the marks
  // of every connector that signs in with it.
  it('a replaced vault key voids the marks of the connectors that use it', async () => {
    const state = async (slug: string) => {
      const [r] = (await exec(sqlTag`
        select slug, handler, requires_confirm as "requiresConfirm",
          external_access as "externalAccess", description, input_schema as "inputSchema"
        from tools where id = ${ids[slug]!}`)) as unknown as Parameters<
        typeof ta.connectorMarkState
      >[0][];
      return ta.connectorMarkState(r!);
    };
    const bind = (secretRef: string | null) =>
      exec(sqlTag`
        update tool_groups set integration = ${JSON.stringify({
          service: 'mcp-site',
          mcp: {
            url: 'https://mcp.example.test/mcp',
            ...(secretRef ? { secretRef } : {}),
          },
        })}::jsonb
        where owner_id = ${anchor} and slug = 'mcp-site'`);
    expect((await switchOn('site_query')).ok).toBe(true);
    await bind('site-key/default');
    try {
      expect(await ta.voidConnectorMarksForKey(anchor, 'other-key', 'default')).toEqual([]);
      expect(await state('site_query')).toBe('read');
      expect(await ta.voidConnectorMarksForKey(anchor, 'site-key', 'default')).toEqual([
        'mcp-site',
      ]);
      expect(await state('site_query')).toBe('stale');
    } finally {
      await bind(null);
      await exec(sqlTag`update tools set enabled = true where id = ${ids.site_query!}`);
      await switchOn('site_query');
    }
  });
});
