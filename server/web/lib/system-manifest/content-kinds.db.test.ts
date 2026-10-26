/**
 * The content-kind groups reach every workspace's assistant ONCE (owner
 * rule 2026-10-26: Present is a workspace content kind of its own; the
 * agents of a user who may write canvases may write them too; the grant is
 * made once per agent, decision 2026-10-26), on one migrated scratch
 * database, switched to workspaces:
 *
 *  - the Admin persona and another workspace's assistant (copied before
 *    Present: app-data, present-read, an operator group) gain what they
 *    miss of present-read and present, and keep every group they had;
 *  - nothing else changes: the other workspace's assistant gets none of the
 *    persona's other groups (the persona reconcile stays Admin's alone);
 *  - a responder on no workspace, the team responder (its manifest entry
 *    owns its groups) and a disabled assistant gain nothing;
 *  - a second run changes nothing (idempotent);
 *  - an owner who removes a group after the grant keeps it removed: the
 *    next reconcile (this step and the persona's) does not add it back;
 *  - an assistant made after the first run gets them at the next one, and
 *    a group not yet granted to an agent (a later release's) reaches it once;
 *  - the ids of deleted agents leave the record;
 *  - no tool of an adminOnly group reaches an assistant outside Admin
 *    (groupsForAgent), asserted on the tools the agent ends up holding.
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
  const setGroups = async (key: string, groups: string[]) =>
    x(sql`update agents set tool_group_slugs = ${`{${groups.join(',')}}`}::text[]
      where id = ${ids[key]}`);
  /** The record of granted groups, agent id to slugs. */
  const granted = async () =>
    ((
      await x<{ g: Record<string, string[]> | null }>(sql`
        select preferences->'contentKindGroupsGranted' as g from profiles where user_id = ${owner}`)
    )[0]?.g ?? {}) as Record<string, string[]>;
  /** The tools an agent holds: the union of its groups' tools. */
  const toolsOf = async (key: string) =>
    (
      await x<{ t: string }>(sql`
        select distinct unnest(g.tool_slugs) as t from tool_groups g
          join agents a on g.slug = any(a.tool_group_slugs) and g.owner_id = a.owner_id
         where a.id = ${ids[key]} and g.enabled`)
    )
      .map((r) => r.t)
      .sort();

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

    // Idempotent: a second run (and the whole reconcile's persona step)
    // changes nothing more on the other workspace.
    expect(await rec.reconcileAssistantContentKinds(owner)).toEqual([]);
    await rec.reconcilePersonaCapabilitiesByRole(owner);
    expect(await groupsOf('other')).toEqual([...copied, 'present']);
  });

  it('an owner who removes a group after the grant keeps it removed', async () => {
    // The owner takes Present's write off the other workspace's assistant and
    // both groups off the persona, in Studio.
    const other = (await groupsOf('other')).filter((g) => g !== 'present');
    await setGroups('other', other);
    const persona = (await groupsOf('persona')).filter(
      (g) => !manifest.ASSISTANT_CONTENT_KIND_GROUPS.includes(g),
    );
    await setGroups('persona', persona);
    expect(await rec.reconcileAssistantContentKinds(owner)).toEqual([]);
    await rec.reconcilePersonaCapabilitiesByRole(owner);
    expect(await groupsOf('other')).toEqual(other);
    expect(await groupsOf('persona')).toEqual(persona);
    expect((await granted())[ids.other!]).toEqual(['present-read', 'present']);
  });

  it('an assistant made later gets them once; a group not yet granted reaches an agent once', async () => {
    await agent('later', { role: 'assistant', workspaceId: otherWs, groups: ['memory-core'] });
    expect(await rec.reconcileAssistantContentKinds(owner)).toEqual([
      `${tag}-later:+present-read,present`,
    ]);
    expect(await groupsOf('later')).toEqual(['memory-core', 'present-read', 'present']);
    expect((await granted())[ids.later!]).toEqual(['present-read', 'present']);

    // A group a later release adds to the list: no id lists it yet. Here the
    // record of `other` lists present-read alone, as before such a release.
    await x(sql`update profiles set preferences = jsonb_set(preferences,
      array['contentKindGroupsGranted', ${ids.other!}]::text[], '["present-read"]'::jsonb)
      where user_id = ${owner}`);
    const before = await groupsOf('other');
    expect(before).not.toContain('present');
    expect(await rec.reconcileAssistantContentKinds(owner)).toEqual([`${tag}-other:+present`]);
    expect(await groupsOf('other')).toEqual([...before, 'present']);
    // Once: removed again, it stays removed.
    await setGroups('other', before);
    expect(await rec.reconcileAssistantContentKinds(owner)).toEqual([]);
    expect(await groupsOf('other')).toEqual(before);
  });

  it('drops the ids of deleted agents from the record', async () => {
    await agent('gone', { role: 'assistant', workspaceId: otherWs, groups: [] });
    await rec.reconcileAssistantContentKinds(owner);
    expect(Object.keys(await granted())).toContain(ids.gone);
    await x(sql`delete from agents where id = ${ids.gone}`);
    await rec.reconcileAssistantContentKinds(owner);
    expect(Object.keys(await granted())).not.toContain(ids.gone);
    expect(Object.keys(await granted())).toContain(ids.other);
  });

  it('no tool of an adminOnly group reaches an assistant outside Admin', async () => {
    // Both groups as the manifest ships them, both made adminOnly: `present`
    // also holds the read tools, so one adminOnly group alone would leave
    // the assertion below with nothing to catch.
    const groups = manifest.MANIFEST_TOOL_GROUPS.filter((g) =>
      manifest.ASSISTANT_CONTENT_KIND_GROUPS.includes(g.slug),
    );
    expect(groups.map((g) => g.slug).sort()).toEqual(['present', 'present-read']);
    const presentTools = [...new Set(groups.flatMap((g) => [...g.toolSlugs]))].sort();
    for (const g of groups) {
      await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, admin_only)
        values (${owner}, ${g.slug}, ${g.name}, ${`{${g.toolSlugs.join(',')}}`}::text[], true)
        on conflict (owner_id, slug) do update
          set admin_only = true, tool_slugs = excluded.tool_slugs, enabled = true`);
    }
    await agent('other2', { role: 'assistant', workspaceId: otherWs, groups: [] });
    await agent('admin2', { role: 'assistant', workspaceId: adminWs, groups: [] });
    await rec.reconcileAssistantContentKinds(owner);
    expect(await groupsOf('other2')).toEqual([]);
    expect(await toolsOf('other2')).toEqual([]);
    expect(await groupsOf('admin2')).toEqual(['present-read', 'present']);
    expect(await toolsOf('admin2')).toEqual(presentTools);
    // Not granted, so not recorded: were the group opened to every
    // workspace, it would reach other2 then.
    expect((await granted())[ids.other2!]).toBeUndefined();
  });
});
