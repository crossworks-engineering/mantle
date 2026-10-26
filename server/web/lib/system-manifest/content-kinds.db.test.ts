/**
 * The content-kind groups reach every workspace's assistant (owner rule
 * 2026-10-26: Present is a workspace content kind of its own; the agents of
 * a user who may write canvases may write them too), on one migrated
 * scratch database, switched to workspaces:
 *
 *  - the Admin persona and another workspace's assistant (copied before
 *    Present: app-data, present-read, an operator group) gain what they
 *    miss of present-read and present, and keep every group they had;
 *  - nothing else changes: the other workspace's assistant gets none of the
 *    persona's other groups (the persona reconcile stays Admin's alone);
 *  - a responder on no workspace, the team responder (its manifest entry
 *    owns its groups) and a disabled assistant gain nothing;
 *  - a second run changes nothing (add-only, idempotent);
 *  - an adminOnly group is never added outside Admin (groupsForAgent).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/system-manifest/content-kinds.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('every workspace assistant holds the content-kind groups', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let rec: typeof import('./reconcile');
  let manifest: typeof import('./manifest');
  const owner = randomUUID();
  const tag = `ckg${randomUUID().slice(0, 6)}`;
  const ids: Record<string, string> = {};
  let adminWs = '';
  let otherWs = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const agent = async (
    key: string,
    opts: {
      role: string;
      workspaceId: string | null;
      groups: string[];
      slug?: string;
      enabled?: boolean;
    },
  ) => {
    const groups = `{${opts.groups.join(',')}}`;
    const [row] = await x<{ id: string }>(sql`
      insert into agents (owner_id, slug, name, model, provider, system_prompt, role, audience,
                          workspace_id, tool_group_slugs, enabled)
      values (${owner}, ${opts.slug ?? `${tag}-${key}`}, ${key}, 'fake/model', 'local', 'x',
              ${opts.role}, 'admin', ${opts.workspaceId}, ${groups}::text[],
              ${opts.enabled ?? true})
      returning id::text as id`);
    ids[key] = row!.id;
  };
  const groupsOf = async (key: string) =>
    (
      await x<{ g: string[] }>(sql`select tool_group_slugs as g from agents where id = ${ids[key]}`)
    )[0]!.g;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    rec = await import('./reconcile');
    manifest = await import('./manifest');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    adminWs = (
      await x<{ id: string }>(sql`select id::text as id from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    otherWs = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} other`}) returning id::text as id`)
    )[0]!.id;
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('adds present-read and present to the persona and to another workspace’s assistant, add-only', async () => {
    // The persona as a site box has it: every persona group but `present`.
    const personaBefore = manifest.PERSONA_TOOL_GROUP_SLUGS.filter((g) => g !== 'present');
    await agent('persona', { role: 'responder', workspaceId: adminWs, groups: personaBefore });
    // Another workspace's assistant, copied before Present, plus an
    // operator's own group.
    const copied = ['memory-core', 'app-data', 'present-read', `${tag}-own`];
    await agent('other', { role: 'assistant', workspaceId: otherWs, groups: copied });
    await agent('none', { role: 'responder', workspaceId: null, groups: [] });
    await agent('team', {
      role: 'custom',
      workspaceId: otherWs,
      groups: ['team-read'],
      slug: 'team-responder',
    });
    await agent('off', { role: 'assistant', workspaceId: otherWs, groups: [], enabled: false });

    const changes = await rec.reconcileAssistantContentKinds(owner);
    expect(changes.sort()).toEqual([`${tag}-other:+present`, `${tag}-persona:+present`].sort());
    expect(await groupsOf('persona')).toEqual([...personaBefore, 'present']);
    expect(await groupsOf('other')).toEqual([...copied, 'present']);
    expect(await groupsOf('none')).toEqual([]);
    expect(await groupsOf('team')).toEqual(['team-read']);
    expect(await groupsOf('off')).toEqual([]);

    // Add-only and idempotent: a second run (and the whole reconcile's
    // persona step) changes nothing more on the other workspace.
    expect(await rec.reconcileAssistantContentKinds(owner)).toEqual([]);
    await rec.reconcilePersonaCapabilitiesByRole(owner);
    expect(await groupsOf('other')).toEqual([...copied, 'present']);
  });

  it('never adds an adminOnly group outside Admin', async () => {
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, admin_only)
      values (${owner}, 'present-read', 'Present (read)', '{}'::text[], true)
      on conflict (owner_id, slug) do update set admin_only = true`);
    await agent('other2', { role: 'assistant', workspaceId: otherWs, groups: [] });
    await agent('admin2', { role: 'assistant', workspaceId: adminWs, groups: [] });
    await rec.reconcileAssistantContentKinds(owner);
    expect(await groupsOf('other2')).toEqual(['present']);
    expect(await groupsOf('admin2')).toEqual(['present-read', 'present']);
  });
});
