/**
 * A login's connector tools: one rule for its app runs, its MCP call and its
 * MCP listing (workspaces W4b fix round 2), on a scratch brain the
 * workspaces migration made live:
 *
 *  - an app the Team holds, run by a member (the member tool broker, the real
 *    route; since W7e every app a member runs is a brain item, checked
 *    against its holders): a member removed from the workspace that holds
 *    the connector is refused a read tool, a member who is not a Moderator
 *    there is refused a write tool;
 *  - the MCP listing (resolveLoginToolRows' connector half,
 *    listLoginConnectorTools with the login) equals the tools its MCP call
 *    (callLoginTool) and its app runs (appToolVerdict) let through, for a
 *    Moderator, a plain user and a login in no workspace;
 *  - a member-built app an admin opens (the owner tool broker): the Team
 *    rule, never the admin's own connectors (W5a audit W1).
 *
 * Only the sign-in, the app lookup, the app logs and the remote dispatch are
 * stood in; every rule is the real one on Postgres.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/app/api/member/apps/member-connectors.turn-scope.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  owner: '',
  login: '',
  toolSlugs: [] as string[],
  dispatched: [] as string[],
}));

const ownerSession = () => ({
  id: h.owner,
  email: 'o@example.invalid',
  actor: { id: h.owner, email: 'o@example.invalid', displayName: 'O', isOwner: true },
});

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ownerSession()),
  // The owner runner routes take every login since W7e: here the owner.
  getOwnerOr401WithLogin: vi.fn(async () => ({
    kind: 'admin',
    user: ownerSession(),
    source: 'web',
    member: null,
  })),
  getMemberOr401: vi.fn(async () => ({
    role: 'member',
    loginId: h.login,
    anchorId: h.owner,
    spaceId: h.login,
    email: 'm@example.invalid',
    displayName: 'M',
    contactId: null,
  })),
}));
// An app the Team holds (APP below, a real node): team rules for a member.
vi.mock('@/lib/member-apps', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  memberAppOr404: vi.fn(async () => ({
    id: '77777777-7777-4777-8777-777777777777',
    title: 'Mine',
    writable: true,
    manifest: { toolSlugs: h.toolSlugs },
    ownerId: h.owner,
  })),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordAppAccess: vi.fn(),
  recordAppError: vi.fn(),
  // A member-built app, as the owner broker sees it.
  getAppRuntime: vi.fn(async () => ({
    toolRules: 'admin',
    authorLevel: 'team',
    manifest: { toolSlugs: h.toolSlugs },
  })),
}));
// The remote call itself: every gate before it is real.
vi.mock('@mantle/tools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchTool: vi.fn(async (tool: { slug: string }) => {
    h.dispatched.push(tool.slug);
    return { ok: true, output: 'ran' };
  }),
}));

describe.skipIf(!URL)('a login’s connector tools: one rule (W4b fix round 2)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tools: typeof import('@mantle/tools');
  let mcp: typeof import('@mantle/mcp-core');
  let broker: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  let ownerBroker: typeof broker;
  const owner = randomUUID();
  const moderator = randomUUID();
  const plain = randomUUID();
  const stranger = randomUUID();
  let team = '';
  // Connector A: a resource of Team, Write on. Connector B: team level, but
  // no workspace holds it (W5b2: its level opens nothing).
  const A = 'conn-a';
  const B = 'conn-b';
  const SLUGS = { aRead: 'conn_a_read', aWrite: 'conn_a_write', bRead: 'conn_b_read' };

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const call = async (login: string, slug: string) => {
    h.login = login;
    const res = await broker(
      new Request('http://brain.invalid/api/member/apps/x/tool-broker', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, input: {} }),
      }),
      { params: Promise.resolve({ id: '77777777-7777-4777-8777-777777777777' }) },
    );
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tools = await import('@mantle/tools');
    mcp = await import('@mantle/mcp-core');
    broker = (await import('./[id]/tool-broker/route')).POST;
    ownerBroker = (await import('../../apps/[id]/tool-broker/route')).POST;
    h.owner = owner;
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role) values
      (${owner}, ${`co-${owner.slice(0, 8)}@example.invalid`}, 'x', true, 'admin'),
      (${moderator}, ${`cm-${moderator.slice(0, 8)}@example.invalid`}, 'x', false, 'member'),
      (${plain}, ${`cp-${plain.slice(0, 8)}@example.invalid`}, 'x', false, 'member'),
      (${stranger}, ${`cs-${stranger.slice(0, 8)}@example.invalid`}, 'x', false, 'member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    for (const [slug, toolSlugs] of [
      [A, [SLUGS.aRead, SLUGS.aWrite]],
      [B, [SLUGS.bRead]],
    ] as const) {
      const binding = JSON.stringify({
        service: slug,
        mcp: { url: 'https://mcp.example.invalid/mcp' },
      });
      await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, integration)
        values (${owner}, ${slug}, ${slug}, ${`{${toolSlugs.join(',')}}`}::text[], 'team', true, ${binding}::jsonb)`);
    }
    const tool = (slug: string, group: string) => ({
      slug,
      handler: { kind: 'mcp' as const, group, toolName: slug },
      description: slug,
      inputSchema: { type: 'object', properties: {} },
    });
    for (const [slug, group, readOnly] of [
      [SLUGS.aRead, A, true],
      [SLUGS.aWrite, A, false],
      [SLUGS.bRead, B, true],
    ] as const) {
      const t = tool(slug, group);
      // The admin's read-only mark, on the handler as it stands.
      const mark = readOnly
        ? JSON.stringify({
            confirmedReadOnlyAt: new Date().toISOString(),
            by: { via: 'web' },
            handlerSig: tools.externalAccessToolSig(t as never),
          })
        : null;
      await x(sql`insert into tools (owner_id, slug, name, description, input_schema, handler, external_access)
        values (${owner}, ${slug}, ${slug}, ${slug}, ${JSON.stringify(t.inputSchema)}::jsonb,
                ${JSON.stringify(t.handler)}::jsonb, ${mark}::jsonb)`);
    }
    await x(sql`select * from mantle_ws_migrate()`);
    const [teamRow] = await x<{ id: string }>(sql`
      select id::text as id from workspaces where owner_id = ${owner} and bridge_key = 'team'`);
    team = teamRow!.id;
    // The app the brokers run: a brain item homed in Team (its one holder).
    const APP = '77777777-7777-4777-8777-777777777777';
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${APP}, ${owner}, 'app', 'Mine', 'apps')`);
    await x(sql`insert into apps (node_id, manifest) values (${APP}, '{}'::jsonb)`);
    await m.withHeads([APP], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${APP}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${APP}, ${team}, true)`);
    });
    // B on no workspace; A on Team with Write on.
    await x(sql`delete from workspace_resources where type = 'connector' and ref_id = ${B}`);
    await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${team}, 'connector', ${A}, true)
      on conflict do nothing`);
    await x(sql`update workspace_resources set write = true
      where workspace_id = ${team} and type = 'connector' and ref_id = ${A}`);
    await x(sql`update workspace_users set moderator = true
      where workspace_id = ${team} and login_id = ${moderator}`);
    await x(sql`update workspace_users set moderator = false
      where workspace_id = ${team} and login_id = ${plain}`);
    await x(sql`delete from workspace_users where login_id = ${stranger}`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  beforeEach(() => {
    h.dispatched = [];
    h.toolSlugs = Object.values(SLUGS);
  });

  describe('a member’s own app (the member tool broker)', () => {
    it('a Moderator of the holding workspace runs a read and a write', async () => {
      expect(await call(moderator, SLUGS.aRead)).toMatchObject({ status: 200 });
      expect(await call(moderator, SLUGS.aWrite)).toMatchObject({ status: 200 });
      expect(h.dispatched).toEqual([SLUGS.aRead, SLUGS.aWrite]);
    });

    it('a non-Moderator is refused a write tool (reads still run)', async () => {
      const w = await call(plain, SLUGS.aWrite);
      expect(w.status).toBe(403);
      expect(w.body.error).toMatch(/Write switched on in a workspace where you are a Moderator/);
      expect(await call(plain, SLUGS.aRead)).toMatchObject({ status: 200 });
      expect(h.dispatched).toEqual([SLUGS.aRead]);
    });

    it('a member removed from the holding workspace is refused a read tool', async () => {
      const removed = randomUUID();
      await x(sql`insert into auth.users (id, email, password_hash, is_owner, role)
        values (${removed}, ${`cr-${removed.slice(0, 8)}@example.invalid`}, 'x', false, 'member')`);
      // On Team, then taken off it, as a Moderator would (W5b2: no login
      // bridge puts a new login anywhere).
      await x(
        sql`insert into workspace_users (workspace_id, login_id) values (${team}, ${removed})`,
      );
      expect(
        await x(sql`delete from workspace_users where workspace_id = ${team}
          and login_id = ${removed} returning login_id`),
      ).toHaveLength(1);
      const r = await call(removed, SLUGS.aRead);
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/not a user of any workspace/);
      expect(h.dispatched).toEqual([]);
    });

    it('a connector no workspace holds is refused, even to a Moderator', async () => {
      const r = await call(moderator, SLUGS.bRead);
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/not a resource of any of your workspaces/);
    });
  });

  describe('a member-built app an admin opens (the owner tool broker)', () => {
    const ownerCall = async (slug: string) => {
      const res = await ownerBroker(
        new Request('http://brain.invalid/api/apps/x/tool-broker', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug, input: {} }),
        }),
        { params: Promise.resolve({ id: '77777777-7777-4777-8777-777777777777' }) },
      );
      return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
    };

    it('Team Write off: the write is refused, though the admin may write A elsewhere', async () => {
      const [adminWs] = await x<{ id: string }>(sql`
        select id::text as id from workspaces where owner_id = ${owner} and is_admin`);
      // The admin's own rule would let the write through (A with Write on
      // in the Admin workspace, where the owner is a Moderator)...
      await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
        values (${adminWs!.id}, 'connector', ${A}, true)
        on conflict (workspace_id, type, ref_id) do update set write = true`);
      expect(
        await tools.appToolVerdict('team', owner, Object.values(SLUGS), SLUGS.aWrite, owner),
      ).toMatchObject({ ok: true });
      await x(sql`update workspace_resources set write = false
        where workspace_id = ${team} and type = 'connector' and ref_id = ${A}`);
      try {
        // ...but a member-built app runs at team rules: the Team rule.
        const w = await ownerCall(SLUGS.aWrite);
        expect(w.status).toBe(403);
        expect(w.body.error).toMatch(/Team workspace does not hold with Write on/);
        expect(await ownerCall(SLUGS.aRead)).toMatchObject({ status: 200 });
        expect(h.dispatched).toEqual([SLUGS.aRead]);
      } finally {
        await x(sql`update workspace_resources set write = true
          where workspace_id = ${team} and type = 'connector' and ref_id = ${A}`);
      }
      // Team Write on again: the same write runs.
      expect(await ownerCall(SLUGS.aWrite)).toMatchObject({ status: 200 });
    });
  });

  describe('the MCP listing equals what the login may call', () => {
    const caller = (loginId: string) => ({
      role: 'member' as const,
      anchorId: owner,
      loginId,
      via: 'oauth' as const,
      write: true,
    });
    const listed = async (login: string) =>
      (await tools.listLoginConnectorTools(owner, login)).map((c) => c.tool.slug).sort();
    // The one MCP surface (W7b): the connector rows the route prepares,
    // registered and called as /api/mcp calls them, in the login's scope.
    const callable = async (login: string) => {
      const rows = [];
      for (const slug of Object.values(SLUGS)) rows.push((await tools.resolveTool(owner, slug))!);
      type Handler = (a: unknown, e: unknown) => Promise<{ isError?: boolean }>;
      const handlers = new Map<string, Handler>();
      const fake = {
        registerTool: (name: string, _c: unknown, cb: Handler) => void handlers.set(name, cb),
      };
      mcp.registerPreparedTools(fake as never, {
        kind: 'owner',
        caller: caller(login),
        view: { holdsAdmin: false, areas: new Set() },
        privateWs: null,
        connectors: rows,
      });
      const out: string[] = [];
      for (const slug of Object.values(SLUGS)) {
        const res = await handlers.get(slug)!({}, {});
        if (!res.isError) out.push(slug);
      }
      return out.sort();
    };
    const brokered = async (login: string) => {
      const out: string[] = [];
      for (const slug of Object.values(SLUGS)) {
        const v = await tools.appToolVerdict('team', owner, Object.values(SLUGS), slug, login);
        if (v.ok) out.push(slug);
      }
      return out.sort();
    };

    it.each([
      ['a Moderator', () => moderator, [SLUGS.aRead, SLUGS.aWrite]],
      ['a plain user', () => plain, [SLUGS.aRead]],
      ['a login in no workspace', () => stranger, []],
    ])('%s', async (_name, who, want) => {
      const login = who();
      expect(await listed(login)).toEqual([...want].sort());
      expect(await callable(login)).toEqual([...want].sort());
      expect(await brokered(login)).toEqual([...want].sort());
    });
  });
});
