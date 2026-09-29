/**
 * Agent levels where client and public meet (client logins audit A5,
 * migration 0189), on a real, migrated Postgres. Since decision 3 the
 * client role reads client items only and the public role public items
 * only, so the two are siblings, not a chain:
 *
 *  - a public agent run from a client scope is refused (it would otherwise
 *    read every public item) and reads nothing;
 *  - the client role loads client agents and tool groups only, never public
 *    ones, so a client scope cannot even find a public agent to delegate to;
 *  - a public scope never runs a client agent (invoke_agent refuses it);
 *  - a team scope still delegates to an admin agent, which runs at team.
 *
 * Only the model is faked. Seeds its own agents, groups and two pages on
 * the shared anchor, and removes them after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runtime/src/agent/agent-level.viewer.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ levels: [] as string[] }));

vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chat = async () => {
    const { currentViewerLevel } = await import('@mantle/db/viewer');
    h.levels.push(currentViewerLevel());
    return { text: 'child done', model: 'fake/model' };
  };
  return {
    ...actual,
    getChatAdapter: vi.fn(() => ({ providerId: 'local', adapterName: 'fake-chat', chat })),
  };
});

describe.skipIf(!URL)('agent levels: client and public never meet', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor = '';
  const tag = `agentlvl${crypto.randomUUID().slice(0, 8)}`;
  const LEVELS = ['admin', 'team', 'client', 'public'] as const;
  const agentSlug = (l: string) => `${tag}-agent-${l}`;
  const groupSlug = (l: string) => `${tag}-group-${l}`;
  const page = { client: crypto.randomUUID(), public: crypto.randomUUID() };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin);
    for (const l of LEVELS) {
      await admin`insert into tool_groups (owner_id, slug, name, tool_slugs, audience)
        values (${anchor}, ${groupSlug(l)}, ${tag}, ${[`${tag}-tool-${l}`]}, ${l})`;
      await admin`insert into agents (owner_id, slug, name, model, provider, system_prompt,
                                      tool_group_slugs, audience)
        values (${anchor}, ${agentSlug(l)}, ${tag}, 'fake/model', 'local', 'x',
                ${[groupSlug(l)]}, ${l})`;
    }
    await admin`insert into nodes (id, owner_id, type, title, path, audience) values
      (${page.client}, ${anchor}, 'page', ${`${tag} client`}, 'pages', 'client'),
      (${page.public}, ${anchor}, 'page', ${`${tag} public`}, 'pages', 'public')`;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from traces where agent_id in (select id from agents where slug like ${`${tag}-%`})`;
    await admin`delete from agents where slug like ${`${tag}-%`}`;
    await admin`delete from tool_groups where slug like ${`${tag}-%`}`;
    await admin`delete from nodes where id in (${page.client}, ${page.public})`;
    await m?.closeDb();
  });

  const readPages = () =>
    m.db.execute(
      sqlTag`select id from nodes where id in (${page.client}, ${page.public})`,
    ) as unknown as Promise<{ id: string }[]>;

  it('a public agent under a client scope is refused and reads 0 public items', async () => {
    const { withAgentViewer } = await import('./agent-viewer');
    const { ViewerLevelConflictError } = await import('@mantle/db/viewer');
    let read: { id: string }[] | null = null;
    await m.withViewer('client', async () => {
      await expect(
        withAgentViewer({ audience: 'public' }, async () => {
          read = await readPages();
          return read;
        }),
      ).rejects.toBeInstanceOf(ViewerLevelConflictError);
    });
    expect(read).toBeNull();
    // The client scope itself reads its own level only.
    const own = await m.withViewer('client', readPages);
    expect(own.map((r) => r.id)).toEqual([page.client]);
  });

  it('the client role loads client agents and tool groups only (0189)', async () => {
    const slugs = await m.withViewer('client', async () => ({
      agents: (
        (await m.db.execute(
          sqlTag`select slug from agents where slug like ${`${tag}-%`} order by slug`,
        )) as unknown as { slug: string }[]
      ).map((r) => r.slug),
      groups: (
        (await m.db.execute(
          sqlTag`select slug from tool_groups where slug like ${`${tag}-%`} order by slug`,
        )) as unknown as { slug: string }[]
      ).map((r) => r.slug),
    }));
    expect(slugs).toEqual({ agents: [agentSlug('client')], groups: [groupSlug('client')] });
  });

  it('a client-level agent never gets a public tool group, and a public one under a client caller gets none', async () => {
    const { resolveAgentToolGroups } = await import('./skills');
    const both = [groupSlug('client'), groupSlug('public')];
    // Admin caller, client agent: the public group is not the client's.
    expect(await resolveAgentToolGroups(anchor, both, 'client')).toEqual([`${tag}-tool-client`]);
    // Client caller, public agent: no common level, no tools.
    expect(
      await m.withViewer('client', () => resolveAgentToolGroups(anchor, both, 'public')),
    ).toEqual([]);
  });

  it('invoke_agent: no public agent for a client, no client agent for a public caller', async () => {
    const { invokeAgent } = await import('./invoke-agent');
    const call = (slug: string) =>
      invokeAgent({
        ownerId: anchor,
        agentSlug: slug,
        prompt: 'hi',
        depth: 1,
        parentTraceId: null,
      });
    h.levels = [];
    // The client role cannot even load a public agent.
    const fromClient = await m.withViewer('client', () => call(agentSlug('public')));
    expect(fromClient).toMatchObject({ ok: false });
    // The public role loads every agent, but a client one is refused before it runs.
    const fromPublic = await m.withViewer('public', () => call(agentSlug('client')));
    expect(fromPublic).toMatchObject({ ok: false });
    expect((fromPublic as { error: string }).error).toMatch(/client-level.*public/);
    expect(h.levels).toEqual([]);
  });

  it('team delegation to an admin agent still works, at team', async () => {
    const { invokeAgent } = await import('./invoke-agent');
    h.levels = [];
    const res = await m.withViewer('team', () =>
      invokeAgent({
        ownerId: anchor,
        agentSlug: agentSlug('admin'),
        prompt: 'hi',
        depth: 1,
        parentTraceId: null,
      }),
    );
    expect(res).toMatchObject({ ok: true, text: 'child done' });
    expect(h.levels).toEqual(['team']);
  });
});
