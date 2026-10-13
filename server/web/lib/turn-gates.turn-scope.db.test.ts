/**
 * The gates of a workspace turn, end to end through the real entry points
 * (workspaces W4b fix round 1, M1, M3, L2, L3), on a scratch brain the
 * workspaces migration made live:
 *
 *  - dispatchTool inside withTurnScope: an adminOnly tool (by slug, and by a
 *    row whose builtin handler is one) refused outside Admin; a connector
 *    tool refused when the connector is not a resource of the scope, when
 *    its Write is off, and when the login is not a Moderator there;
 *  - enqueue from a scope: runs of another workspace (or none) refused;
 *  - withRunScope: a Team run re-enters [Team], an Admin run the system
 *    pool, a run whose login is no user of the workspace is refused;
 *  - spilled results (loadResult): only the scope's own login's rows of the
 *    scope;
 *  - a member's own MCP call of a connector tool (callLoginTool): the same
 *    resource, Write and Moderator rules.
 *
 * On a scratch database of its own: the workspaces migration is per brain.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/turn-gates.turn-scope.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '@mantle/db';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('workspace turn gates (W4b fix round 1)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tools: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  const owner = randomUUID();
  const member = randomUUID();
  const member2 = randomUUID();
  const stranger = randomUUID();
  let team = '';
  let admin = '';
  const CONN = 'conn-x';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const scope = (modWs: string[] = [team], login: string | null = member) => ({
    kind: 'assistant' as const,
    loginId: login,
    ws: [team],
    modWs,
  });
  const fakeTool = (slug: string, handler: Record<string, unknown>): Tool =>
    ({
      slug,
      name: slug,
      description: slug,
      handler,
      inputSchema: { type: 'object', properties: {} },
      requiresConfirm: false,
      externalAccess: null,
    }) as unknown as Tool;
  const connTool = fakeTool('conn_x_do', { kind: 'mcp', group: CONN, toolName: 'do' });
  const ctx = (surface: Record<string, unknown> = { kind: 'team', loginId: member }) => ({
    ownerId: owner,
    surface: surface as never,
  });
  const setTeamResource = async (row: { write: boolean } | null) => {
    await x(sql`delete from workspace_resources
      where workspace_id = ${team} and type = 'connector' and ref_id = ${CONN}`);
    if (row) {
      await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
        values (${team}, 'connector', ${CONN}, ${row.write})`);
    }
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tools = await import('@mantle/tools');
    rt = await import('@mantle/runtime/agent');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${`go-${owner.slice(0, 8)}@example.invalid`}, 'x', true, 'admin'),
      (${member}, ${`gm-${member.slice(0, 8)}@example.invalid`}, 'x', false, 'member'),
      (${member2}, ${`g2-${member2.slice(0, 8)}@example.invalid`}, 'x', false, 'member'),
      (${stranger}, ${`gs-${stranger.slice(0, 8)}@example.invalid`}, 'x', false, 'member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    // A connector the bridge puts on Admin only; the tests set Team's
    // resource row by hand.
    const binding = JSON.stringify({
      service: CONN,
      mcp: { url: 'https://mcp.example.invalid/mcp' },
    });
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, enabled, integration)
      values (${owner}, ${CONN}, 'Connector X', ARRAY['conn_x_do']::text[], true, ${binding}::jsonb)`);
    await x(sql`select * from mantle_ws_migrate()`);
    const wsRows = await x<{ id: string; key: string }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key from workspaces where owner_id = ${owner}`);
    team = wsRows.find((r) => r.key === 'team')!.id;
    admin = wsRows.find((r) => r.key === 'admin')!.id;
    // The stranger is a user of no workspace of this brain.
    await x(sql`delete from workspace_users where login_id = ${stranger}`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  describe('dispatchTool in a turn scope', () => {
    it('an adminOnly tool is refused outside Admin, by slug and by handler ref (L2)', async () => {
      // The owner's surface, so the ownerOnly gate passes and the adminOnly
      // one decides.
      const web = ctx({ kind: 'web' });
      const bySlug = fakeTool('replay_window', { kind: 'builtin', ref: 'replay_window' });
      const byRef = fakeTool('renamed_export', { kind: 'builtin', ref: 'export_node' });
      for (const tool of [bySlug, byRef]) {
        const res = await m.withTurnScope(scope(), () => tools.dispatchTool(tool, {}, web));
        expect(res).toEqual({ ok: false, error: tools.ADMIN_ONLY_ERROR });
      }
      // The Admin workspace in scope: the gate lets it through (whatever the
      // tool then answers).
      const inAdmin = await m.withTurnScope(
        { kind: 'assistant', loginId: owner, ws: [admin], modWs: [admin] },
        () => tools.dispatchTool(byRef, {}, web),
      );
      expect(inAdmin.ok ? null : inAdmin.error).not.toBe(tools.ADMIN_ONLY_ERROR);
    });

    it('a connector not a resource of the scope is refused', async () => {
      await setTeamResource(null);
      const res = await m.withTurnScope(scope(), () => tools.dispatchTool(connTool, {}, ctx()));
      expect(res.ok).toBe(false);
      expect(res.ok ? '' : res.error).toMatch(/not one of this workspace's resources/);
    });

    it('a write tool needs the resource Write on', async () => {
      await setTeamResource({ write: false });
      const res = await m.withTurnScope(scope(), () => tools.dispatchTool(connTool, {}, ctx()));
      expect(res.ok ? '' : res.error).toMatch(/needs the connector’s Write switched on/);
    });

    it('a write tool needs the login a Moderator there', async () => {
      await setTeamResource({ write: true });
      const res = await m.withTurnScope(scope([]), () => tools.dispatchTool(connTool, {}, ctx()));
      expect(res.ok ? '' : res.error).toMatch(/a Moderator here/);
    });
  });

  describe('runs carry the scope', () => {
    const run = async (ws: string | null, login: string | null) => {
      const [r] = await x<{ id: string }>(sql`
        insert into runs (owner_id, title, workspace_id, login_id)
        values (${owner}, 'r', ${ws}, ${login}) returning id::text as id`);
      return r!.id;
    };

    it('assertRunsCarryScope: only runs of the scope pass; enqueue refuses the rest', async () => {
      const runs = await import('@mantle/runs');
      const mine = await run(team, member);
      const adminRun = await run(admin, member);
      const resume = (runId: string) => [{ type: 'resume' as const, runId, groupId: 'g' }];
      await expect(
        m.withTurnScope(scope(), () => runs.assertRunsCarryScope(resume(mine))),
      ).resolves.toBeUndefined();
      for (const id of [adminRun, randomUUID()]) {
        await expect(
          m.withTurnScope(scope(), () => runs.assertRunsCarryScope(resume(id))),
        ).rejects.toThrow(/must name runs of that scope/);
        await expect(
          m.withTurnScope(scope(), () => runs.enqueueRunJobs(resume(id))),
        ).rejects.toThrow(/must name runs of that scope/);
      }
    });

    it('withRunScope: Team re-enters [Team], Admin re-enters [Admin] (W7a)', async () => {
      expect(
        await rt.withRunScope({ workspaceId: team, loginId: member }, async () => m.currentScope()),
      ).toMatchObject({ kind: 'assistant', loginId: member, ws: [team], modWs: [team] });
      expect(
        await rt.withRunScope({ workspaceId: team, loginId: null }, async () => m.currentScope()),
      ).toMatchObject({ kind: 'assistant', loginId: null, ws: [team], modWs: [] });
      expect(
        await rt.withRunScope({ workspaceId: admin, loginId: owner }, async () => m.currentScope()),
      ).toMatchObject({ kind: 'assistant', loginId: owner, ws: [admin] });
      // No workspace (NULL = Admin): the brain's Admin workspace, for the owner.
      expect(
        await rt.withRunScope({ workspaceId: null, ownerId: owner }, async () => m.currentScope()),
      ).toMatchObject({ kind: 'assistant', loginId: owner, ws: [admin] });
      // No brain to find (no owner on the run): the system pool, as before.
      expect(await rt.withRunScope({ workspaceId: null }, async () => m.currentScope())).toEqual({
        kind: 'system',
      });
      // The rollback switch: Admin on the system pool, as before W7a.
      process.env.MANTLE_ADMIN_READS = 'system';
      try {
        expect(
          await rt.withRunScope({ workspaceId: admin, loginId: owner }, async () =>
            m.currentScope(),
          ),
        ).toEqual({ kind: 'system' });
      } finally {
        delete process.env.MANTLE_ADMIN_READS;
      }
    });

    it('withAgentScope refuses a login with no user row in the workspace (L3)', async () => {
      await expect(
        rt.withRunScope({ workspaceId: team, loginId: stranger }, async () => 1),
      ).rejects.toBeInstanceOf(rt.AgentWorkspaceError);
      await expect(
        rt.withAgentScope({ workspaceId: team }, async () => 1, {
          loginId: stranger,
        }),
      ).rejects.toThrow(/not a user of the assistant’s workspace/);
    });
  });

  it('spilled results: the scope reads its own login’s rows of the scope only', async () => {
    const spill = async (id: string, ws: string | null, login: string | null) =>
      x(sql`insert into tool_results (id, owner_id, tool_slug, content, bytes, workspace_id, login_id)
        values (${id}, ${owner}, 'search_nodes', ${`content of ${id}`}, 20, ${ws}, ${login})`);
    const tag = randomUUID().slice(0, 8);
    const h = {
      mine: `r-${tag}-mine`,
      other: `r-${tag}-other`,
      admin: `r-${tag}-admin`,
      none: `r-${tag}-none`,
    };
    await spill(h.mine, team, member);
    await spill(h.other, team, member2);
    await spill(h.admin, admin, member);
    await spill(h.none, null, null);
    const read = (handle: string) =>
      m.withTurnScope(scope(), () => tools.readResultPage(owner, handle, 1, 10_000));
    expect(await read(h.mine)).toMatchObject({ ok: true, text: `content of ${h.mine}` });
    for (const handle of [h.other, h.admin, h.none]) {
      expect(await read(handle)).toMatchObject({ ok: false });
    }
  });

  it('draw_get in a Team turn: Team-visible images only, never an unnamed exit (fix round 2)', async () => {
    const [draw, teamFile, adminFile] = [randomUUID(), randomUUID(), randomUUID()];
    // New items live in Admin (their home); Team holds the drawing and one
    // image by a grant (W5b2: grants decide, the level is frozen).
    await x(sql`insert into nodes (id, owner_id, type, title, path, data) values
      (${draw}, ${owner}, 'draw', 'Plant layout', 'draws', '{}'::jsonb),
      (${teamFile}, ${owner}, 'file', 'team.png', 'files',
        ${JSON.stringify({ text: 'TEAM IMAGE WORDS' })}::jsonb),
      (${adminFile}, ${owner}, 'file', 'admin.png', 'files',
        ${JSON.stringify({ text: 'ADMIN IMAGE WORDS' })}::jsonb)`);
    for (const id of [draw, teamFile]) {
      await m.withSubtreeHeads(id, [], async (tx) => {
        await tx.execute(
          sql`insert into item_grants (node_id, workspace_id) values (${id}, ${team})`,
        );
      });
    }
    const refs = JSON.stringify({ 'f-team': teamFile, 'f-admin': adminFile });
    await x(sql`insert into draws (node_id, scene, scene_text, scene_svg, file_refs)
      values (${draw}, '{"elements":[]}'::jsonb, 'TEAM IMAGE WORDS ADMIN IMAGE WORDS',
              '<svg xmlns="http://www.w3.org/2000/svg"/>', ${refs}::jsonb)`);
    const content = await import('@mantle/content');
    const drawGet = fakeTool('draw_get', { kind: 'builtin', ref: 'draw_get' });
    // NODE_ENV is 'test': an unnamed asSystem inside the turn throws
    // TurnScopeExitError, and the draw reader no longer swallows it.
    const [res, svg] = await m.withTurnScope(scope(), async () => [
      await tools.dispatchTool(drawGet, { id: draw }, ctx()),
      await content.readableDrawSvg(owner, draw),
    ]);
    expect(res.ok).toBe(true);
    const text = String((res as { output: { content: string } }).output.content);
    expect(text).toContain('TEAM IMAGE WORDS');
    expect(text).not.toContain('ADMIN IMAGE WORDS');
    expect([...(svg?.visibleFileIds ?? ['all'])]).toEqual(['f-team']);
  });

  describe('a member’s own MCP call of a connector tool (M3)', () => {
    const caller = (loginId: string) => ({
      role: 'member' as const,
      anchorId: owner,
      loginId,
      via: 'oauth' as const,
      write: true,
    });
    // The one MCP surface (W7b): the connector registered and called as
    // /api/mcp does, in the login's scope.
    const call = async (loginId: string) => {
      const ls = await import('@mantle/mcp-core');
      type Out = { isError?: boolean; content: { text?: string }[] };
      let handler: ((a: unknown, e: unknown) => Promise<Out>) | undefined;
      const fake = {
        registerTool: (name: string, _c: unknown, cb: (a: unknown, e: unknown) => Promise<Out>) => {
          if (name === connTool.slug) handler = cb;
        },
      };
      ls.registerPreparedTools(fake as never, {
        kind: 'owner',
        caller: caller(loginId),
        view: { holdsAdmin: false, areas: new Set() },
        privateWs: null,
        connectors: [connTool],
      });
      const out = await handler!({}, {});
      return {
        isError: out.isError === true,
        text: out.content.map((c) => c.text ?? '').join('\n'),
      };
    };

    it('refused when the connector is in none of the login’s workspaces', async () => {
      await setTeamResource(null);
      const out = await call(member);
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/not a resource of any of your workspaces/);
    });

    it('a write tool refused with Write off', async () => {
      await setTeamResource({ write: false });
      expect((await call(member)).text).toMatch(
        /Write switched on in a workspace where you are a Moderator/,
      );
    });

    it('a write tool refused when the login moderates no workspace holding it', async () => {
      await setTeamResource({ write: true });
      await x(sql`update workspace_users set moderator = false
        where workspace_id = ${team} and login_id = ${member2}`);
      expect((await call(member2)).text).toMatch(/where you are a Moderator/);
    });

    it('a login with no workspace on a migrated brain is refused', async () => {
      expect((await call(stranger)).text).toMatch(/user of no workspace/);
    });

    it('what the rule lets through: a read with the resource; a write with Write and a Moderator', async () => {
      await setTeamResource({ write: false });
      expect(await tools.loginConnectorRefused(owner, member2, CONN, false)).toBeNull();
      await setTeamResource({ write: true });
      await x(sql`update workspace_users set moderator = true
        where workspace_id = ${team} and login_id = ${member}`);
      expect(await tools.loginConnectorRefused(owner, member, CONN, true)).toBeNull();
    });
  });
});
