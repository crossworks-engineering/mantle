/**
 * Agent levels where client and public meet (client logins audit A5,
 * migration 0189), on a real, migrated Postgres. Since decision 3 the
 * client role reads client items only and the public role public items
 * only, so the two are siblings, not a chain:
 *
 *  - a public agent run from a client scope reads nothing (W5b2: it runs
 *    in the caller's workspace scope or none, never at its own level);
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

  it('a public agent under a client scope reads 0 public items, never wider', async () => {
    // W5b2 (R6): an agent on no workspace runs in the caller's workspace
    // scope, never wider; outside one, the shim gives it no workspace. The
    // level meeting that refused it is gone with the level engine; what it
    // guarded stays asserted: the public page never reaches it.
    const { withAgentViewer } = await import('./agent-viewer');
    const fromLevel = await m.runInLevelRoleForTest('client', () =>
      // Awaited inside: a query handed out unrun leaves the scope (refused).
      withAgentViewer({ audience: 'public' }, async () => await readPages()),
    );
    expect(fromLevel).toEqual([]);
    const inScope = await m.withViewer('client', { agent: null }, async () => ({
      outer: m.currentScope(),
      inner: await withAgentViewer({ audience: 'public' }, async () => ({
        scope: m.currentScope(),
        read: await readPages(),
      })),
    }));
    expect(inScope.inner).toEqual({ scope: inScope.outer, read: [] });
    // The client role itself reads its own level only.
    const own = await m.runInLevelRoleForTest('client', readPages);
    expect(own.map((r) => r.id)).toEqual([page.client]);
  });

  it('the client role loads client agents and tool groups only (0189)', async () => {
    const slugs = await m.runInLevelRoleForTest('client', async () => ({
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

  it('W7b: no level cap on groups: an agent gets the groups it holds that the reader may load', async () => {
    const { resolveAgentToolGroups } = await import('./skills');
    const both = [groupSlug('client'), groupSlug('public')];
    // System work: every group it holds (tool-group levels went in W7b).
    expect(await resolveAgentToolGroups(anchor, both)).toEqual([
      `${tag}-tool-client`,
      `${tag}-tool-public`,
    ]);
    // The client role loads its own groups only (0189): never wider.
    expect(
      await m.runInLevelRoleForTest('client', () => resolveAgentToolGroups(anchor, both)),
    ).toEqual([`${tag}-tool-client`]);
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
    const fromClient = await m.runInLevelRoleForTest('client', () => call(agentSlug('public')));
    expect(fromClient).toMatchObject({ ok: false });
    // The public role loads every agent, but a client one is refused before it runs.
    const fromPublic = await m.runInLevelRoleForTest('public', () => call(agentSlug('client')));
    expect(fromPublic).toMatchObject({ ok: false });
    expect((fromPublic as { error: string }).error).toMatch(/client-level.*public/);
    expect(h.levels).toEqual([]);
  });

  it('team delegation to an admin agent still works, at team', async () => {
    const { invokeAgent } = await import('./invoke-agent');
    h.levels = [];
    const res = await m.runInLevelRoleForTest('team', () =>
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
