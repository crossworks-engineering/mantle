/**
 * W8 integration: the audit fixes on agents with no workspace, on one
 * migrated scratch database, first as a brain NOT on workspaces, then
 * switched (mantle_ws_migrate).
 *
 * Not on workspaces:
 *  - C-L2: a helper asked for by a login that is not an admin reads
 *    nothing; asked for by an admin login it runs on the system pool;
 *  - C-M2: a responder on no workspace with no login still does system work;
 *  - C-M1 and C-L1: the persona reconcile reaches the responders whose
 *    frozen level was admin and gives them every persona group, an adminOnly
 *    one included; a responder of another frozen level gains nothing.
 * On workspaces:
 *  - C-M2: a responder or an assistant on no workspace with no login is
 *    refused (AgentWorkspaceError); a specialist still does system work;
 *  - C-M1: the persona reconcile reaches only the Admin workspace's
 *    assistants: a responder on no workspace gains nothing, whatever its
 *    frozen level.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w8-int.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('W8 integration: agents with no workspace', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let rt: typeof import('@mantle/runtime/agent');
  let rec: typeof import('../lib/system-manifest/reconcile');
  let manifest: typeof import('../lib/system-manifest/manifest');
  const owner = randomUUID(); // the anchor, an admin login
  const mem = randomUUID(); // a member login
  const page = randomUUID();
  const tag = `w8i${randomUUID().slice(0, 6)}`;
  const ids: Record<string, string> = {};

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const agent = async (
    key: string,
    role: string,
    audience: string,
    workspaceId: string | null = null,
  ) => {
    const [row] = await x<{ id: string }>(sql`
      insert into agents (owner_id, slug, name, model, provider, system_prompt, role, audience,
                          workspace_id, tool_group_slugs)
      values (${owner}, ${`${tag}-${key}`}, ${key}, 'fake/model', 'local', 'x', ${role},
              ${audience}, ${workspaceId}, '{}'::text[])
      returning id::text as id`);
    ids[key] = row!.id;
    return { id: row!.id, ownerId: owner, workspaceId, role };
  };
  const groupsOf = async (key: string) =>
    (
      await x<{ g: string[] }>(sql`select tool_group_slugs as g from agents where id = ${ids[key]}`)
    )[0]!.g;
  const readPage = async () =>
    (await m.db.select({ id: m.nodes.id }).from(m.nodes).where(eq(m.nodes.id, page))).map(
      (r) => r.id,
    );

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.MANTLE_ADMIN_READS;
    m = await import('@mantle/db');
    rt = await import('@mantle/runtime/agent');
    rec = await import('../lib/system-manifest/reconcile');
    manifest = await import('../lib/system-manifest/manifest');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${mem}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${page}, ${owner}, 'page', ${`${tag} page`}, 'pages')`);
    // One persona group is adminOnly: the Admin persona still gets it.
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, admin_only)
      values (${owner}, ${manifest.PERSONA_TOOL_GROUP_SLUGS[0]!}, 'adminOnly persona group',
              '{}'::text[], true)`);
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  describe('a brain not on workspaces', () => {
    it('C-L2: a helper asked for by a non-admin login reads nothing; by an admin, the system pool', async () => {
      const helper = await agent('helper', 'custom', 'admin');
      expect(await rt.withAgentScope(helper, readPage, { loginId: mem })).toEqual([]);
      expect(await rt.withAgentScope(helper, readPage, { loginId: owner })).toEqual([page]);
    });

    it('C-M2: a responder on no workspace with no login still does system work', async () => {
      const responder = await agent('lone-responder', 'responder', 'admin');
      expect(await rt.withAgentScope(responder, readPage)).toEqual([page]);
    });

    it('C-M1, C-L1: the persona reconcile reaches the frozen-admin responders, with every group', async () => {
      await agent('admin-persona', 'responder', 'admin');
      await agent('team-persona', 'responder', 'team');
      await rec.reconcilePersonaCapabilitiesByRole(owner);
      expect(await groupsOf('admin-persona')).toEqual([...manifest.PERSONA_TOOL_GROUP_SLUGS]);
      expect(await groupsOf('team-persona')).toEqual([]);
    });
  });

  describe('switched to workspaces', () => {
    let adminWs = '';

    beforeAll(async () => {
      await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
      adminWs = (
        await x<{ id: string }>(sql`select id::text as id from workspaces
          where owner_id = ${owner} and is_admin and archived_at is null`)
      )[0]!.id;
    }, 240_000);

    it('C-M2: a responder or an assistant on no workspace with no login is refused', async () => {
      for (const role of ['responder', 'assistant']) {
        const a = await agent(`none-${role}`, role, 'admin');
        await expect(rt.withAgentScope(a, async () => 'ran')).rejects.toBeInstanceOf(
          rt.AgentWorkspaceError,
        );
      }
    });

    it('C-M2: a specialist (role custom) with no login still does system work', async () => {
      const specialist = await agent('specialist', 'custom', 'admin');
      expect(await rt.withAgentScope(specialist, readPage)).toEqual([page]);
    });

    it('C-M1: the persona reconcile reaches only the Admin workspace’s assistants', async () => {
      await agent('none-admin-level', 'responder', 'admin');
      await agent('admin-ws', 'responder', 'admin', adminWs);
      await rec.reconcilePersonaCapabilitiesByRole(owner);
      expect(await groupsOf('none-admin-level')).toEqual([]);
      expect(await groupsOf('admin-ws')).toEqual([...manifest.PERSONA_TOOL_GROUP_SLUGS]);
    });
  });
});
