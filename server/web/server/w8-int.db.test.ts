/**
 * W8 integration: the audit fixes on agents with no workspace, on one
 * migrated scratch database, switched (mantle_ws_migrate). The cases of a
 * brain NOT on workspaces went with that brain's rules in arch A7.
 *
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
      // The content-kind groups aside: those are granted once, by their own
      // step (reconcileAssistantContentKinds, content-kinds.db.test.ts).
      expect(await groupsOf('admin-ws')).toEqual(
        manifest.PERSONA_TOOL_GROUP_SLUGS.filter(
          (g) => !manifest.ASSISTANT_CONTENT_KIND_GROUPS.includes(g),
        ),
      );
    });
  });
});
